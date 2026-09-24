/** Loads a page in real Chromium and gathers what a browsing agent would see. */
import { chromium, type Browser, type Page } from "playwright";

export interface Evidence {
  url: string;
  finalUrl: string;
  status: number | null;
  title: string;
  robotsTxt: string | null;
  jsonLd: unknown[];
  jsonLdErrors: string[];
  meta: Record<string, string>;
  /** Product-like JSON-LD found in the raw server HTML (no JavaScript executed). */
  noJsProductData: boolean;
  noJsTextLength: number;
  purchaseControls: { role: string; name: string }[];
  unnamedPurchaseControls: number;
  visibleText: string;
  ariaSnapshot: string;
  botWall: string | null;
}

const PURCHASE_TEXT =
  /add to (cart|bag|basket)|buy( it)? now|checkout|añadir al carrito|agregar al carrito|comprar|ajouter au panier|in den warenkorb/i;

/** Default budget for the optional network-idle wait after the load event. */
export const SETTLE_MS = 5000;

/**
 * Waits for the network to go quiet, but never longer than `ms`. Real shops often never reach
 * `networkidle` (tracking pixels, long-polling, chat widgets), so this is best-effort by design.
 */
export async function settle(page: Page, ms = SETTLE_MS): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}

/** Navigates to the load event, then settles; returns the navigation response. */
export async function open(page: Page, url: string, timeout: number, settleMs = SETTLE_MS) {
  const response = await page.goto(url, { waitUntil: "load", timeout });
  await settle(page, settleMs);
  return response;
}

export interface CollectOptions {
  userAgent?: string;
  timeoutMs?: number;
  browser?: Browser;
  /** Delay before the single retry of a bare HTTP 503 (default 3000 ms). */
  retryDelayMs?: number;
  /** Budget for the best-effort network-idle wait (default SETTLE_MS). */
  settleMs?: number;
}

export async function collect(url: string, opts: CollectOptions = {}): Promise<Evidence> {
  const timeout = opts.timeoutMs ?? 30000;
  const browser = opts.browser ?? (await chromium.launch());
  try {
    const context = await browser.newContext(opts.userAgent ? { userAgent: opts.userAgent } : {});
    const page = await context.newPage();
    let response = await open(page, url, timeout, opts.settleMs);
    let retried = false;
    if (response?.status() === 503 && !CHALLENGE.test(await response.text())) {
      // A bare 503 is often transient: retry once before calling it a bot wall.
      await page.waitForTimeout(opts.retryDelayMs ?? 3000);
      response = await open(page, url, timeout, opts.settleMs);
      retried = true;
    }
    const finalUrl = page.url();

    const robotsTxt = await fetchRobots(context.request, finalUrl);
    const { jsonLd, jsonLdErrors } = await readJsonLd(page);
    const meta = await page.$$eval("meta[property], meta[name]", (els) =>
      Object.fromEntries(
        els.map((e) => [e.getAttribute("property") ?? e.getAttribute("name") ?? "", e.getAttribute("content") ?? ""]),
      ),
    );
    const controls = await readPurchaseControls(page);
    // Truncated to bound memory: a price rendered past the first 20k chars is not seen by priceVisible().
    const visibleText = (await page.locator("body").innerText({ timeout })).slice(0, 20000);
    const ariaSnapshot = (await page.locator("body").ariaSnapshot({ timeout })).slice(0, 20000);
    const title = await page.title();
    const status = response?.status() ?? null;
    const html = response ? await response.text() : "";
    await context.close();

    const noJs = await collectNoJs(browser, html);
    return {
      url,
      finalUrl,
      status,
      title,
      robotsTxt,
      jsonLd,
      jsonLdErrors,
      meta,
      noJsProductData: noJs.hasProduct,
      noJsTextLength: noJs.textLength,
      purchaseControls: controls.named,
      unnamedPurchaseControls: controls.unnamed,
      visibleText,
      ariaSnapshot,
      botWall: detectBotWall(status, html, visibleText, retried),
    };
  } finally {
    if (!opts.browser) await browser.close();
  }
}

async function fetchRobots(request: import("playwright").APIRequestContext, pageUrl: string) {
  try {
    const res = await request.get(new URL("/robots.txt", pageUrl).href, { timeout: 10000 });
    return res.ok() ? await res.text() : null;
  } catch {
    return null;
  }
}

async function readJsonLd(page: Page) {
  const raw = await page.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent ?? ""));
  const jsonLd: unknown[] = [];
  const jsonLdErrors: string[] = [];
  for (const text of raw) {
    try {
      jsonLd.push(JSON.parse(text));
    } catch (err) {
      jsonLdErrors.push((err as Error).message);
    }
  }
  return { jsonLd, jsonLdErrors };
}

async function readPurchaseControls(page: Page) {
  const named: { role: string; name: string }[] = [];
  for (const role of ["button", "link"] as const) {
    const loc = page.getByRole(role, { name: PURCHASE_TEXT });
    for (const el of await loc.all()) {
      if (await el.isVisible()) named.push({ role, name: (await el.getAttribute("aria-label")) ?? (await el.innerText()).trim() });
    }
  }
  // Clickable things that look like a buy control visually (class/id/data attrs) but expose no accessible name.
  const unnamed = await page.$$eval(
    'button, a, [role="button"], [onclick], input[type="submit"], input[type="button"]',
    (els, src) => {
      const re = new RegExp(src, "i");
      return els.filter((el) => {
        const hint = [el.id, el.className, ...Array.from(el.attributes).map((a) => a.value)].join(" ");
        const label =
          (el.getAttribute("aria-label") ?? "") +
          (el.textContent ?? "") +
          ((el as HTMLInputElement).value ?? "") +
          (el.getAttribute("title") ?? "");
        return /cart|buy|checkout|carrito|comprar|basket/i.test(hint) && !re.test(label) && label.trim() === "";
      }).length;
    },
    PURCHASE_TEXT.source,
  );
  return { named, unnamed };
}

async function collectNoJs(browser: Browser, html: string) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const blocks = await page.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent ?? ""));
    const hasProduct = blocks.some((b) => {
      try {
        return findProducts(JSON.parse(b)).length > 0;
      } catch {
        return false;
      }
    });
    const textLength = (await page.locator("body").innerText().catch(() => "")).trim().length;
    return { hasProduct, textLength };
  } finally {
    await context.close();
  }
}

const CHALLENGE = /cf-chl|challenge-platform|captcha|perimeterx|px-captcha|datadome|akamai/i;

function detectBotWall(status: number | null, html: string, text: string, retried = false): string | null {
  if (status === 403 || status === 429 || status === 503) {
    if (CHALLENGE.test(html)) return `HTTP ${status} with an anti-bot challenge`;
    if (status === 503 && retried) return "HTTP 503 (transient or bot protection; retried once)";
    return `HTTP ${status}`;
  }
  if (/verify you are (a )?human|are you a robot|g-recaptcha|h-captcha|cf-turnstile/i.test(html + text)) {
    return "CAPTCHA / human verification on page";
  }
  return null;
}

/** Walks JSON-LD (arrays, @graph) and returns every node typed Product or ProductGroup. */
export function findProducts(node: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== "object") return;
    const obj = n as Record<string, unknown>;
    const types = ([] as unknown[]).concat(obj["@type"] ?? []);
    if (types.some((t) => t === "Product" || t === "ProductGroup")) out.push(obj);
    if (obj["@graph"]) visit(obj["@graph"]);
  };
  visit(node);
  return out;
}
