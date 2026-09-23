/**
 * Agentic mystery shopper: walks the purchase journey in real Chromium through ARIA roles and
 * accessible names only. Never types into forms and never presses a pay / place-order control.
 */
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { findProducts } from "./collect.js";

/** Controls the shopper must never press: the payment boundary. */
export const PAY = /\b(pay|place (your )?order|complete (purchase|order)|confirm (and pay|order|purchase)|buy now and pay|submit order)\b|pagar|realizar pedido|confirmar (pedido|compra)|finalizar compra y pagar|payer|commande confirm/i;
const OVERLAY = /^(accept( all)?( cookies)?|allow all|agree|i agree|got it|ok|aceptar( todo| todas)?( las cookies)?|entendido|close|cerrar|dismiss|no,? thanks|no gracias|continue shopping|×|✕)$/i;
const ADD = /add to (cart|bag|basket)|añadir (al|a la) (carrito|cesta)|agregar al carrito|ajouter au panier|in den warenkorb/i;
const TO_CHECKOUT = /checkout|proceed|tramitar|finalizar (pedido|compra)|ir a pagar|continuar (con|al) (el )?(pago|pedido)|caisse|zur kasse/i;
const TO_CART = /view (cart|bag|basket)|go to (cart|bag|basket)|^(cart|bag|basket)\b|ver (el )?(carrito|cesta)|ir al carrito|^carrito|^cesta|panier|warenkorb/i;
const GUEST = /guest|invitado|sin registr|without (an )?account|como invitado|invité|gast/i;

export type StepStatus = "passed" | "failed" | "skipped";
export interface Step {
  id: string;
  status: StepStatus;
  detail: string;
}
export interface JourneyReport {
  url: string;
  steps: Step[];
  reachedPaymentBoundary: boolean;
  overlaysDismissed: string[];
  productPrice: number | null;
  checkoutTotal: number | null;
  priceDrift: number | null;
  autocomplete: { fields: number; covered: number; missing: string[] } | null;
  loginWall: boolean | null;
  score: number;
}

export interface JourneyOptions {
  browser?: Browser;
  userAgent?: string;
  tracePath?: string;
  timeoutMs?: number;
}

export async function runJourney(url: string, opts: JourneyOptions = {}): Promise<JourneyReport> {
  const browser = opts.browser ?? (await chromium.launch());
  const context = await browser.newContext(opts.userAgent ? { userAgent: opts.userAgent } : {});
  if (opts.tracePath) await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeoutMs ?? 10000);
  const r: JourneyReport = {
    url,
    steps: [],
    reachedPaymentBoundary: false,
    overlaysDismissed: [],
    productPrice: null,
    checkoutTotal: null,
    priceDrift: null,
    autocomplete: null,
    loginWall: null,
    score: 0,
  };
  const step = (id: string, status: StepStatus, detail: string) => r.steps.push({ id, status, detail });
  try {
    const res = await page.goto(url, { waitUntil: "networkidle" });
    if (!res || res.status() >= 400) {
      step("load", "failed", `HTTP ${res?.status() ?? "no response"}`);
      return finish(r);
    }
    step("load", "passed", `HTTP ${res.status()}`);

    r.overlaysDismissed = await dismissOverlays(page);
    r.productPrice = await productPrice(page);

    const variant = await chooseVariants(page);
    step("variant", variant.status, variant.detail);

    const add = await firstVisible(page, ["button", "link"], ADD);
    if (!add) {
      step("add-to-cart", "failed", "No visible button/link with an add-to-cart accessible name");
      return finish(r);
    }
    const blocker = await obstruction(add);
    if (blocker) {
      step("add-to-cart", "failed", `Add-to-cart is covered by another element: ${blocker}`);
      return finish(r);
    }
    const addName = await accessibleName(add);
    const before = await observe(page);
    await add.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(300);
    step("add-to-cart", "passed", `Pressed "${addName}"`);
    const signal = cartSignal(before, await observe(page));
    step("cart-signal", signal ? "passed" : "failed", signal ?? "No URL change, live region, status or dialog after adding: an agent cannot confirm it worked");

    r.overlaysDismissed.push(...(await dismissOverlays(page)));
    const reached = await walkToCheckout(page);
    step("reach-checkout", reached.status, reached.detail);
    if (reached.status !== "passed") return finish(r);

    r.loginWall = await loginWall(page);
    step("guest-checkout", r.loginWall ? "failed" : "passed", r.loginWall ? "Checkout requires a password with no guest option" : "Checkout usable without an account");

    r.autocomplete = await autocompleteCoverage(page);
    const ac = r.autocomplete;
    step(
      "autocomplete",
      ac.fields === 0 ? "skipped" : ac.covered === ac.fields ? "passed" : "failed",
      ac.fields === 0 ? "No checkout inputs visible yet" : `${ac.covered}/${ac.fields} inputs carry autocomplete tokens${ac.missing.length ? `; missing: ${ac.missing.join(", ")}` : ""}`,
    );

    r.checkoutTotal = await totalOnPage(page);
    if (r.productPrice !== null && r.checkoutTotal !== null) {
      r.priceDrift = round2(r.checkoutTotal - r.productPrice);
      step(
        "price-drift",
        r.priceDrift > 0 ? "failed" : "passed",
        `Product ${r.productPrice} → checkout total ${r.checkoutTotal} (${r.priceDrift >= 0 ? "+" : ""}${r.priceDrift})`,
      );
    } else {
      step("price-drift", "skipped", "Could not read both the product price and a checkout total");
    }

    const pay = await firstVisible(page, ["button", "link"], PAY);
    r.reachedPaymentBoundary = pay !== null;
    step(
      "payment-boundary",
      pay ? "passed" : "failed",
      pay ? `Found "${await accessibleName(pay)}" — stopped here, not pressed` : "No pay / place-order control found by role and name",
    );
    return finish(r);
  } finally {
    if (opts.tracePath) await context.tracing.stop({ path: opts.tracePath });
    await context.close();
    if (!opts.browser) await browser.close();
  }
}

function finish(r: JourneyReport): JourneyReport {
  const graded = r.steps.filter((s) => s.status !== "skipped");
  r.score = graded.length ? Math.round((100 * graded.filter((s) => s.status === "passed").length) / graded.length) : 0;
  return r;
}

export async function firstVisible(page: Page, roles: ("button" | "link")[], name: RegExp): Promise<Locator | null> {
  for (const role of roles) {
    for (const el of await page.getByRole(role, { name }).all()) {
      if (await el.isVisible()) return el;
    }
  }
  return null;
}

async function accessibleName(el: Locator): Promise<string> {
  return ((await el.getAttribute("aria-label")) ?? (await el.innerText())).trim();
}

/** Returns a description of whatever intercepts clicks on `el`, or null when it is clickable. */
async function obstruction(el: Locator): Promise<string | null> {
  await el.scrollIntoViewIfNeeded();
  return el.evaluate((node) => {
    const b = node.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (!hit || node === hit || node.contains(hit)) return null;
    return `<${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}${hit.className ? `.${String(hit.className).split(" ")[0]}` : ""}>`;
  });
}

async function dismissOverlays(page: Page): Promise<string[]> {
  const dismissed: string[] = [];
  for (let i = 0; i < 3; i++) {
    const btn = await firstVisible(page, ["button"], OVERLAY);
    if (!btn) break;
    const name = await accessibleName(btn);
    await btn.click();
    await page.waitForTimeout(200);
    dismissed.push(name);
  }
  return dismissed;
}

async function chooseVariants(page: Page): Promise<{ status: StepStatus; detail: string }> {
  const chosen: string[] = [];
  const unlabeled: number[] = [];
  const selects = await page.locator("select:visible").all();
  for (const [i, sel] of selects.entries()) {
    const label = await sel.evaluate((el) => {
      const s = el as HTMLSelectElement;
      const byId = s.getAttribute("aria-labelledby");
      return (
        s.getAttribute("aria-label") ??
        (byId ? document.getElementById(byId)?.textContent : null) ??
        Array.from(s.labels ?? []).map((l) => l.textContent).join(" ")
      ).trim();
    });
    if (!label) unlabeled.push(i + 1);
    const current = await sel.inputValue();
    const options = await sel.evaluate((el) =>
      Array.from((el as HTMLSelectElement).options).filter((o) => !o.disabled && o.value !== "").map((o) => o.value),
    );
    if (options.length === 0) continue;
    if (!current || !options.includes(current)) {
      await sel.selectOption(options[0]);
      chosen.push(`${label || `select #${i + 1}`}=${options[0]}`);
    }
  }
  for (const group of await page.getByRole("radiogroup").all()) {
    if (!(await group.isVisible())) continue;
    const radios = group.getByRole("radio");
    if ((await group.getByRole("radio", { checked: true }).count()) > 0) continue;
    for (const radio of await radios.all()) {
      if (await radio.isEnabled()) {
        await radio.check();
        chosen.push(`${(await group.getAttribute("aria-label")) ?? "radiogroup"}=${await radio.getAttribute("value")}`);
        break;
      }
    }
  }
  if (unlabeled.length) return { status: "failed", detail: `Variant select(s) #${unlabeled.join(", #")} have no accessible label` };
  if (chosen.length === 0 && selects.length === 0) return { status: "skipped", detail: "No variant controls" };
  return { status: "passed", detail: chosen.length ? `Chose ${chosen.join(", ")}` : "Variants already selected" };
}

interface Observation {
  url: string;
  live: string;
  dialogs: number;
}
async function observe(page: Page): Promise<Observation> {
  const live = await page.$$eval('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], output', (els) =>
    els.map((e) => e.textContent?.trim() ?? "").join(" | "),
  );
  const dialogs = await page.getByRole("dialog").count() + (await page.getByRole("alertdialog").count());
  return { url: page.url(), live, dialogs };
}
function cartSignal(a: Observation, b: Observation): string | null {
  if (b.url !== a.url) return `Navigated to ${b.url}`;
  if (b.live !== a.live && b.live.trim()) return `Live region announced "${b.live.slice(0, 120)}"`;
  if (b.dialogs > a.dialogs) return "A dialog opened";
  return null;
}

async function walkToCheckout(page: Page): Promise<{ status: StepStatus; detail: string }> {
  const path: string[] = [];
  for (let hop = 0; hop < 3; hop++) {
    if (await isCheckout(page)) return { status: "passed", detail: `Reached checkout at ${page.url()}${path.length ? ` via ${path.join(" → ")}` : ""}` };
    const next = (await firstVisible(page, ["button", "link"], TO_CHECKOUT)) ?? (await firstVisible(page, ["link", "button"], TO_CART));
    if (!next) break;
    const name = await accessibleName(next);
    if (PAY.test(name)) break;
    path.push(`"${name}"`);
    await next.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await dismissOverlays(page);
  }
  if (await isCheckout(page)) return { status: "passed", detail: `Reached checkout at ${page.url()} via ${path.join(" → ")}` };
  return { status: "failed", detail: `Could not find a cart/checkout control by role and name${path.length ? ` after ${path.join(" → ")}` : ""}` };
}

async function isCheckout(page: Page): Promise<boolean> {
  const fields = await page.locator('input[type="email"], input[autocomplete*="email"], input[autocomplete*="address"], input[autocomplete*="postal"], input[name*="email" i], input[name*="address" i], input[type="password"]').count();
  return fields > 0 || (await firstVisible(page, ["button"], PAY)) !== null;
}

async function loginWall(page: Page): Promise<boolean> {
  const password = await page.locator('input[type="password"]:visible').count();
  if (password === 0) return false;
  const text = await page.locator("body").innerText();
  return !GUEST.test(text);
}

async function autocompleteCoverage(page: Page) {
  const rows = await page.$$eval(
    'form input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), form select, form textarea',
    (els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => ({
          name: e.getAttribute("name") ?? e.id ?? e.getAttribute("aria-label") ?? "?",
          ac: (e.getAttribute("autocomplete") ?? "").trim().toLowerCase(),
        })),
  );
  const missing = rows.filter((x) => !x.ac || x.ac === "on" || x.ac === "off").map((x) => x.name);
  return { fields: rows.length, covered: rows.length - missing.length, missing };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Parses "1.234,56 €", "€1,234.56", "$89.90", "89,90" into a number. */
export function parsePrice(s: string): number | null {
  const m = /(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/.exec(s);
  if (!m) return null;
  let n = m[1].replace(/\s/g, "");
  const lastSep = Math.max(n.lastIndexOf(","), n.lastIndexOf("."));
  if (lastSep >= 0 && n.length - lastSep - 1 <= 2) {
    n = n.slice(0, lastSep).replace(/[.,]/g, "") + "." + n.slice(lastSep + 1);
  } else {
    n = n.replace(/[.,]/g, "");
  }
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

const MONEY = /(?:[€$£]\s?\d[\d.,\s]*\d|\d[\d.,\s]*\d\s?(?:€|EUR|USD|\$|£))/;

async function productPrice(page: Page): Promise<number | null> {
  const blocks = await page.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent ?? ""));
  for (const b of blocks) {
    try {
      for (const p of findProducts(JSON.parse(b))) {
        const offer = ([] as unknown[]).concat(p.offers ?? [])[0] as Record<string, unknown> | undefined;
        const v = offer ? parsePrice(String(offer.price ?? offer.lowPrice ?? "")) : null;
        if (v !== null) return v;
      }
    } catch {
      /* invalid JSON-LD is reported by the audit, not here */
    }
  }
  const m = MONEY.exec(await page.locator("body").innerText());
  return m ? parsePrice(m[0]) : null;
}

async function totalOnPage(page: Page): Promise<number | null> {
  const lines = (await page.locator("body").innerText()).split("\n");
  let total: number | null = null;
  for (const [i, line] of lines.entries()) {
    if (!/\btotal\b/i.test(line) || /sub-?total/i.test(line)) continue;
    const m = MONEY.exec(line) ?? MONEY.exec(lines[i + 1] ?? "");
    if (m) total = parsePrice(m[0]);
  }
  return total;
}
