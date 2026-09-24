import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { evaluate } from "../src/checks.js";
import { collect } from "../src/collect.js";
import { isAllowed, parseRobots } from "../src/robots.js";
import { startShop } from "./fixture-shop.js";

const PRODUCT = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Trail Shoe",
  sku: "TS-1",
  image: "https://example.com/shoe.jpg",
  offers: { "@type": "Offer", price: "89.90", priceCurrency: "EUR", availability: "https://schema.org/InStock" },
};
const ld = `<script type="application/ld+json">${JSON.stringify(PRODUCT)}</script>`;
const body = `<h1>Trail Shoe</h1><p>${"Lightweight trail running shoe. ".repeat(10)}</p><p>89,90 €</p>`;
const og = `<meta property="og:title" content="Trail Shoe">`;

const pages: Record<string, string> = {
  "/good": `<html><head><title>Shoe</title>${og}${ld}</head><body>${body}<button>Add to cart</button></body></html>`,
  "/jsonly": `<html><head>${og}</head><body>${body}<button>Add to cart</button><script>
    const s=document.createElement('script');s.type='application/ld+json';s.textContent=${JSON.stringify(JSON.stringify(PRODUCT))};document.head.appendChild(s);
  </script></body></html>`,
  "/unnamed": `<html><head>${og}${ld}</head><body>${body}<div class="add-to-cart-btn" onclick="1"><svg width="10" height="10"></svg></div></body></html>`,
};

let server: Server;
let browser: Browser;
let base = "";
let robots = "User-agent: *\nAllow: /\n";

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/robots.txt") return res.end(robots);
    const html = pages[req.url ?? ""];
    res.writeHead(html ? 200 : 404, { "content-type": "text/html" }).end(html ?? "nf");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  server.close();
});

const audit = async (path: string) => evaluate(await collect(base + path, { browser }));

test("robots parser: longest match, specific group wins", () => {
  const g = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: meta-externalagent\nDisallow: /cart\nAllow: /cart/public\n");
  assert.equal(isAllowed(g, "meta-externalagent", "/p/1"), true);
  assert.equal(isAllowed(g, "meta-externalagent", "/cart/x"), false);
  assert.equal(isAllowed(g, "meta-externalagent", "/cart/public/1"), true);
  assert.equal(isAllowed(g, "Googlebot", "/p/1"), false);
});

test("good page has no findings and full score", async () => {
  const r = await audit("/good");
  assert.deepEqual(r.findings, []);
  assert.equal(r.score, 100);
  assert.equal(r.products[0].price, "89.90");
});

test("JS-only product data is flagged", async () => {
  const r = await audit("/jsonly");
  assert.ok(r.findings.some((f) => f.id === "no-js" && f.severity === "warning"));
  assert.ok(!r.findings.some((f) => f.id === "product-schema"), "rendered JSON-LD is still detected");
});

test("robots.txt blocking meta-externalagent is an error", async () => {
  robots = "User-agent: meta-externalagent\nDisallow: /\n";
  try {
    const r = await audit("/good");
    const f = r.findings.find((x) => x.id === "robots-meta-externalagent");
    assert.equal(f?.severity, "error");
  } finally {
    robots = "User-agent: *\nAllow: /\n";
  }
});

test("robots severity: AI-data crawlers are errors, preview bots warnings", async () => {
  robots = "User-agent: facebookexternalhit\nDisallow: /\n\nUser-agent: FacebookBot\nDisallow: /\n";
  try {
    const r = await audit("/good");
    const robotsFindings = r.findings.filter((f) => f.id.startsWith("robots-"));
    assert.deepEqual(robotsFindings.map((f) => [f.id, f.severity]), [
      ["robots-facebookexternalhit", "warning"],
      ["robots-facebookbot", "warning"],
    ]);
    assert.equal(r.score, 80);
  } finally {
    robots = "User-agent: *\nAllow: /\n";
  }
});

test("a request that never finishes does not stall the audit", async () => {
  const shop = await startShop();
  try {
    const r = evaluate(await collect(`${shop.base}/stall`, { browser, settleMs: 300, timeoutMs: 8000 }));
    assert.equal(r.products[0].name, "Ceramic Mug");
    assert.ok(!r.findings.some((f) => f.id === "http-status" || f.id === "bot-wall"));
  } finally {
    shop.close();
  }
});

test("bare 503 is retried once before being reported", async () => {
  const shop = await startShop();
  try {
    const ok = evaluate(await collect(`${shop.base}/flaky`, { browser, retryDelayMs: 50 }));
    assert.equal(shop.flakyHits, 2);
    assert.ok(!ok.findings.some((f) => f.id === "bot-wall"));
    const down = evaluate(await collect(`${shop.base}/down`, { browser, retryDelayMs: 50 }));
    assert.match(down.findings.find((f) => f.id === "bot-wall")!.message, /HTTP 503 \(transient or bot protection; retried once\)/);
  } finally {
    shop.close();
  }
});

test("buy control without accessible name is an error", async () => {
  const r = await audit("/unnamed");
  assert.ok(r.findings.some((f) => f.id === "purchase-control" && f.severity === "error"));
  assert.ok(r.findings.some((f) => f.id === "unnamed-control"));
});

test("404 page is reported", async () => {
  const r = await audit("/missing");
  assert.ok(r.findings.some((f) => f.id === "http-status"));
});
