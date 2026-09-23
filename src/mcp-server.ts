#!/usr/bin/env node
/**
 * Stdio MCP server that gives a Muse Code session a real Chromium to look at shops with.
 * Newline-delimited JSON-RPC 2.0, as in the Muse Code plugin MCP example. Both tools only read.
 */
import { createInterface } from "node:readline";
import { evaluate } from "./checks.js";
import { collect } from "./collect.js";
import { PAY, paymentInputs, runJourney } from "./shopper.js";
import { chromium, type Browser, type Page } from "playwright";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const urlArg = {
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute http(s) URL of a product page." },
    user_agent: { type: "string", description: "Optional User-Agent, e.g. meta-externalagent/1.1." },
  },
  required: ["url"],
};

export const TOOLS = [
  {
    name: "agent_view",
    description:
      "Load a page in headless Chromium and return what a browsing shopping agent perceives: HTTP status, ARIA accessibility snapshot, JSON-LD, visible purchase controls, bot-wall detection.",
    inputSchema: urlArg,
    annotations: { readOnlyHint: true },
  },
  {
    name: "audit_page",
    description:
      "Run the agentic-commerce readiness checks (robots.txt for Meta agents, Product/Offer schema, no-JS render, accessible buy control, price consistency) and return score and findings.",
    inputSchema: urlArg,
    annotations: { readOnlyHint: true },
  },
  {
    name: "mystery_shop",
    description:
      "Walk the purchase journey in Chromium by ARIA role/name: dismiss overlays, pick a variant, add to cart, verify cart feedback, reach checkout, check guest checkout, autocomplete coverage and price drift. Stops at the pay button; never types or pays. Adds an item to a real cart.",
    inputSchema: urlArg,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "shop_open",
    description: "Open a URL in a persistent Chromium tab for step-by-step shopping. Returns URL, title and ARIA snapshot.",
    inputSchema: urlArg,
    annotations: { readOnlyHint: true },
  },
  {
    name: "shop_view",
    description: "Return the current tab's URL, title and ARIA snapshot.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "shop_click",
    description:
      "Click the first visible element with this ARIA role and exact accessible name, as an agent would. Refuses pay / place-order controls.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["button", "link", "checkbox", "radio", "tab", "menuitem", "option"] },
        name: { type: "string", description: "Exact accessible name from the ARIA snapshot." },
      },
      required: ["role", "name"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "shop_select",
    description: "Choose an option in the combobox (select) with this accessible name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, option: { type: "string", description: "Option label or value." } },
      required: ["name", "option"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "shop_close",
    description: "Close the step-by-step shopping tab.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

let browser: Browser | undefined;
let tab: Page | undefined;

const text = (body: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

async function view(page: Page, warning?: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  return text({
    url: page.url(),
    title: await page.title(),
    ...(warning ? { warning } : {}),
    ariaSnapshot: (await page.locator("body").ariaSnapshot()).slice(0, 15000),
  });
}

async function stepTool(name: string, args: Record<string, unknown>) {
  if (!name.startsWith("shop_")) return undefined;
  if (name === "shop_open") {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//.test(url)) return text("url must be absolute http(s)", true);
    browser ??= await chromium.launch();
    await tab?.context().close();
    const ctx = await browser.newContext(typeof args.user_agent === "string" ? { userAgent: args.user_agent } : {});
    tab = await ctx.newPage();
    tab.setDefaultTimeout(10000);
    await tab.goto(url, { waitUntil: "networkidle" });
    return view(tab);
  }
  if (name === "shop_close") {
    await tab?.context().close();
    tab = undefined;
    return text("closed");
  }
  if (!tab) return text("no open tab: call shop_open first", true);
  if (name === "shop_view") return view(tab);
  if (name === "shop_click") {
    const label = String(args.name ?? "");
    if (PAY.test(label)) return text(`refused: "${label}" is a payment control; the mystery shopper stops at the payment boundary`, true);
    const role = String(args.role) as Parameters<Page["getByRole"]>[0];
    for (const el of await tab.getByRole(role, { name: label, exact: true }).all()) {
      if (await el.isVisible()) {
        await el.click();
        await tab.waitForLoadState("networkidle").catch(() => {});
        // The PAY guard only sees accessible names; a "Continue" button can still lead to payment.
        const pay = await paymentInputs(tab);
        return view(tab, pay.length ? `Payment inputs are now visible (${pay.join(", ")}): this is the payment boundary, stop here` : undefined);
      }
    }
    return text(`no visible ${role} named "${label}"`, true);
  }
  if (name === "shop_select") {
    const box = tab.getByRole("combobox", { name: String(args.name ?? ""), exact: true }).first();
    if ((await box.count()) === 0) return text(`no combobox named "${args.name}"`, true);
    const option = String(args.option ?? "");
    await box.selectOption({ label: option }).catch(() => box.selectOption(option));
    return view(tab);
  }
  return undefined;
}

type Msg = { id?: string | number | null; method?: string; params?: Record<string, unknown> };

function send(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function callTool(name: string, args: Record<string, unknown>) {
  const stepped = await stepTool(name, args);
  if (stepped) return stepped;
  const url = String(args.url ?? "");
  if (!/^https?:\/\//.test(url)) return text("url must be absolute http(s)", true);
  const userAgent = typeof args.user_agent === "string" ? args.user_agent : undefined;
  if (name === "mystery_shop") return text(await runJourney(url, { userAgent, browser: (browser ??= await chromium.launch()) }));
  const ev = await collect(url, { userAgent });
  const body =
    name === "agent_view"
      ? {
          finalUrl: ev.finalUrl,
          status: ev.status,
          title: ev.title,
          botWall: ev.botWall,
          purchaseControls: ev.purchaseControls,
          jsonLd: ev.jsonLd,
          ariaSnapshot: ev.ariaSnapshot,
        }
      : evaluate(ev);
  return text(body);
}

export async function handle(msg: Msg): Promise<unknown | undefined> {
  const reply = (body: object) => ({ jsonrpc: "2.0", id: msg.id, ...body });
  switch (msg.method) {
    case "initialize": {
      const v = String(msg.params?.protocolVersion ?? "");
      return reply({
        result: {
          protocolVersion: PROTOCOLS.includes(v) ? v : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "commerce-audit", version: "0.1.0" },
        },
      });
    }
    case "ping":
      return reply({ result: {} });
    case "tools/list":
      return reply({ result: { tools: TOOLS } });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return reply({ error: { code: -32602, message: `unknown tool: ${name}` } });
      try {
        return reply({ result: await callTool(name, (msg.params?.arguments ?? {}) as Record<string, unknown>) });
      } catch (err) {
        return reply({ result: { content: [{ type: "text", text: String((err as Error).message) }], isError: true } });
      }
    }
    default:
      // Notifications (no id) get no reply; unknown requests get method-not-found.
      return msg.id === undefined || msg.id === null
        ? undefined
        : reply({ error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const rl = createInterface({ input: process.stdin });
  const inflight: Promise<void>[] = [];
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    inflight.push(handle(msg).then((r) => { if (r) send(r); }));
  });
  rl.on("close", () => void Promise.all(inflight).then(async () => {
    await browser?.close();
    process.exit(0);
  }));
}
