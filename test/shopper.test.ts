import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { parsePrice, PAY, runJourney } from "../src/shopper.js";
import { startShop, type Shop } from "./fixture-shop.js";

let shop: Shop;
let browser: Browser;
before(async () => {
  shop = await startShop();
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  shop.close();
});

const byId = (r: Awaited<ReturnType<typeof runJourney>>) => Object.fromEntries(r.steps.map((s) => [s.id, s]));

test("full journey reaches the payment boundary and never pays", async () => {
  const trace = join(mkdtempSync(join(tmpdir(), "shop-")), "trace.zip");
  const r = await runJourney(`${shop.base}/pdp`, { browser, tracePath: trace });
  const s = byId(r);
  assert.deepEqual(r.overlaysDismissed, ["Accept all (consent granted)"], "accept is only a fallback, and disclosed");
  for (const id of ["load", "variant", "add-to-cart", "cart-signal", "reach-checkout", "guest-checkout", "payment-boundary"]) {
    assert.equal(s[id].status, "passed", `${id}: ${s[id].detail}`);
  }
  assert.match(s.variant.detail, /Size=m/);
  assert.match(s["cart-signal"].detail, /Added to cart \(1\)/);
  assert.equal(r.reachedPaymentBoundary, true);
  assert.equal(shop.payHits, 0, "pay endpoint must never be hit");
  assert.ok(existsSync(trace));

  assert.equal(s.autocomplete.status, "failed");
  assert.deepEqual(r.autocomplete, { fields: 3, covered: 2, missing: ["fullname"] });
  assert.equal(r.productPrice, 49.9);
  assert.equal(r.checkoutTotal, 54.85);
  assert.equal(r.priceDrift, 4.95);
  assert.equal(s["price-drift"].status, "passed", "a higher total (tax/shipping) is informational");
  assert.match(s["price-drift"].detail, /\+4\.95/);
});

test("cookie banner: reject is preferred over accept", async () => {
  const r = await runJourney(`${shop.base}/pdp-reject`, { browser });
  assert.deepEqual(r.overlaysDismissed, ["Reject all"]);
});

test("checkout total below the product price fails price drift", async () => {
  const r = await runJourney(`${shop.base}/cheap`, { browser });
  const s = byId(r);
  assert.equal(r.priceDrift, -9.9);
  assert.equal(s["price-drift"].status, "failed");
  assert.equal(shop.payHits, 0);
});

test("a cart control that goes nowhere stops with loop detected", async () => {
  const s = byId(await runJourney(`${shop.base}/loop`, { browser }));
  assert.equal(s["reach-checkout"].status, "failed");
  assert.match(s["reach-checkout"].detail, /Loop detected: "View cart"/);
});

test("a request that never finishes does not stall the journey", async () => {
  const started = Date.now();
  const r = await runJourney(`${shop.base}/stall`, { browser, settleMs: 300 });
  assert.equal(byId(r).load.status, "passed");
  assert.equal(byId(r)["reach-checkout"].status, "passed");
  assert.ok(Date.now() - started < 15000);
});

test("add-to-cart with no machine-readable feedback fails the cart signal", async () => {
  const s = byId(await runJourney(`${shop.base}/silent`, { browser }));
  assert.equal(s["add-to-cart"].status, "passed");
  assert.equal(s["cart-signal"].status, "failed");
  assert.equal(s["reach-checkout"].status, "failed");
});

test("password-only checkout is a login wall", async () => {
  const r = await runJourney(`${shop.base}/wall`, { browser });
  assert.equal(r.loginWall, true);
  assert.equal(byId(r)["guest-checkout"].status, "failed");
});

test("price parsing and payment guard", () => {
  assert.equal(parsePrice("1.234,56 €"), 1234.56);
  assert.equal(parsePrice("$1,234.56"), 1234.56);
  assert.equal(parsePrice("89,90"), 89.9);
  assert.equal(parsePrice("1.299 €"), 1299);
  for (const n of ["Place order", "Pagar ahora", "Realizar pedido", "Pay €54.85", "Confirm order"]) assert.ok(PAY.test(n), n);
  for (const n of ["Add to cart", "Proceed to checkout", "View cart"]) assert.ok(!PAY.test(n), n);
});
