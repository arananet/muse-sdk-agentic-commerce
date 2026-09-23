/** Turns collected evidence into findings. Heuristics based on public standards, not Meta's private rules. */
import { findProducts, type Evidence } from "./collect.js";
import { isAllowed, parseRobots } from "./robots.js";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
}

export interface Report {
  url: string;
  score: number;
  findings: Finding[];
  products: { name?: unknown; price?: unknown; currency?: unknown; availability?: unknown }[];
}

/**
 * Meta's documented crawler/fetcher user agents (developers.facebook.com/docs/sharing/webmasters/web-crawlers).
 * These are crawlers, not the shopping agent's (unpublished) browsing UA. Blocking the AI-data agents is an
 * error; blocking the link-preview / legacy bots is common and only loosely related, so it is a warning.
 */
export const META_AGENTS: { ua: string; severity: Severity }[] = [
  { ua: "meta-externalagent", severity: "error" },
  { ua: "meta-externalfetcher", severity: "error" },
  { ua: "facebookexternalhit", severity: "warning" },
  { ua: "FacebookBot", severity: "warning" },
];

/** Uncalibrated weights: the score is a rough ordering signal, not a measured grade. */
const WEIGHT: Record<Severity, number> = { error: 25, warning: 10, info: 0 };

export function evaluate(ev: Evidence): Report {
  const findings: Finding[] = [];
  const add = (id: string, severity: Severity, message: string) => findings.push({ id, severity, message });

  if (ev.botWall) add("bot-wall", "error", `Headless Chromium hit a bot wall: ${ev.botWall}`);
  else if (ev.status !== null && ev.status >= 400) add("http-status", "error", `Page returned HTTP ${ev.status}`);

  if (ev.robotsTxt !== null) {
    const groups = parseRobots(ev.robotsTxt);
    const path = new URL(ev.finalUrl).pathname;
    for (const { ua, severity } of META_AGENTS) {
      if (!isAllowed(groups, ua, path)) add(`robots-${ua.toLowerCase()}`, severity, `robots.txt disallows ${ua} for ${path}`);
    }
  }

  if (ev.jsonLdErrors.length) add("jsonld-invalid", "error", `${ev.jsonLdErrors.length} JSON-LD block(s) fail to parse`);
  const products = ev.jsonLd.flatMap(findProducts);
  const summaries = products.map(summarize);
  if (products.length === 0) {
    add("product-schema", "error", "No schema.org Product/ProductGroup JSON-LD found");
  } else {
    const p = summaries[0];
    if (!p.name) add("product-name", "error", "Product JSON-LD has no name");
    if (p.price === undefined) add("offer-price", "error", "Product JSON-LD has no Offer price");
    if (!p.currency) add("offer-currency", "error", "Offer has no priceCurrency");
    if (!p.availability) add("offer-availability", "warning", "Offer has no availability");
    if (!products[0].image) add("product-image", "warning", "Product JSON-LD has no image");
    if (!products[0].sku && !products[0].gtin13 && !products[0].gtin && !products[0].mpn) {
      add("product-identifier", "warning", "Product has no sku/gtin/mpn identifier");
    }
    if (p.price !== undefined && !priceVisible(String(p.price), ev.visibleText)) {
      add("price-mismatch", "warning", `Structured price ${p.price} is not visible in the rendered page text`);
    }
    if (!ev.noJsProductData) add("no-js", "warning", "Product JSON-LD is only present after JavaScript runs");
  }
  if (ev.noJsTextLength < 200) add("no-js-text", "info", "Server HTML renders almost no text without JavaScript");

  if (ev.purchaseControls.length === 0) {
    add("purchase-control", "error", "No accessible add-to-cart/buy control (by ARIA role and name) is visible");
  }
  if (ev.unnamedPurchaseControls > 0) {
    add("unnamed-control", "warning", `${ev.unnamedPurchaseControls} cart/buy-looking control(s) have no accessible name`);
  }
  if (!ev.meta["og:title"] && !ev.meta["og:type"]) add("open-graph", "info", "No Open Graph tags");

  const score = Math.max(0, 100 - findings.reduce((s, f) => s + WEIGHT[f.severity], 0));
  return { url: ev.finalUrl, score, findings, products: summaries };
}

function summarize(p: Record<string, unknown>) {
  const offers = ([] as unknown[]).concat(p.offers ?? []) as Record<string, unknown>[];
  const o = offers[0] ?? {};
  const price = o.price ?? o.lowPrice ?? (o.priceSpecification as Record<string, unknown> | undefined)?.price;
  return { name: p.name, price, currency: o.priceCurrency, availability: o.availability };
}

function priceVisible(price: string, text: string): boolean {
  const n = Number(price);
  if (Number.isNaN(n)) return text.includes(price);
  const variants = new Set([price, n.toFixed(2), n.toFixed(2).replace(".", ","), String(n), String(n).replace(".", ",")]);
  const compact = text.replace(/\s/g, "");
  return [...variants].some((v) => compact.includes(v));
}
