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

export interface CollectOptions {
  userAgent?: string;
  timeoutMs?: number;
  browser?: Browser;
}

export async function collect(url: string, opts: CollectOptions = {}): Promise<Evidence> {
  const timeout = opts.timeoutMs ?? 30000;
  const browser = opts.browser ?? (await chromium.launch());
  try {
    const context = await browser.newContext(opts.userAgent ? { userAgent: opts.userAgent } : {});
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "networkidle", timeout });
    const finalUrl = page.url();

    const robotsTxt = await fetchRobots(context.request, finalUrl);
    const { jsonLd, jsonLdErrors } = await readJsonLd(page);
    const meta = await page.$$eval("meta[property], meta[name]", (els) =>
      Object.fromEntries(
        els.map((e) => [e.getAttribute("property") ?? e.getAttribute("name") ?? "", e.getAttribute("content") ?? ""]),
      ),
    );
    const controls = await readPurchaseControls(page);
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
      botWall: detectBotWall(status, html, visibleText),
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

function detectBotWall(status: number | null, html: string, text: string): string | null {
  if (status === 403 || status === 429 || status === 503) {
    if (/cf-chl|challenge-platform|captcha|perimeterx|px-captcha|datadome|akamai/i.test(html)) {
      return `HTTP ${status} with an anti-bot challenge`;
    }
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
