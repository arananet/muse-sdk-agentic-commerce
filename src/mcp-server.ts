#!/usr/bin/env node
/**
 * Stdio MCP server that gives a Muse Code session a real Chromium to look at shops with.
 * Newline-delimited JSON-RPC 2.0, as in the Muse Code plugin MCP example. Both tools only read.
 */
import { createInterface } from "node:readline";
import { evaluate } from "./checks.js";
import { collect } from "./collect.js";

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
];

type Msg = { id?: string | number | null; method?: string; params?: Record<string, unknown> };

function send(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function callTool(name: string, args: Record<string, unknown>) {
  const url = String(args.url ?? "");
  if (!/^https?:\/\//.test(url)) return { content: [{ type: "text", text: "url must be absolute http(s)" }], isError: true };
  const userAgent = typeof args.user_agent === "string" ? args.user_agent : undefined;
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
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
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
  rl.on("close", () => void Promise.all(inflight).then(() => process.exit(0)));
}
