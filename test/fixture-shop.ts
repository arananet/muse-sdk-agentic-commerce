/** A small real shop served over HTTP for journey tests. Records whether the pay endpoint is ever hit. */
import { createServer, type Server } from "node:http";

const product = (price: string) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Ceramic Mug",
    sku: "MUG-1",
    offers: { "@type": "Offer", price, priceCurrency: "EUR", availability: "https://schema.org/InStock" },
  })}</script>`;

const PAGES: Record<string, string> = {
  "/pdp": `<html><head><title>Mug</title>${product("49.90")}</head><body>
    <div id="cookie-wall" style="position:fixed;inset:0;background:#fff;z-index:9" role="dialog" aria-label="Cookies">
      <p>We use cookies</p><button onclick="document.getElementById('cookie-wall').remove()">Accept all</button>
    </div>
    <h1>Ceramic Mug</h1><p>49,90 €</p>
    <label for="size">Size</label><select id="size"><option value="">Choose</option><option value="s" disabled>S</option><option value="m">M</option></select>
    <button id="add" onclick="if(!document.getElementById('size').value)return;document.getElementById('msg').textContent='Added to cart (1)';document.getElementById('cartlink').hidden=false">Add to cart</button>
    <p id="msg" aria-live="polite"></p><a id="cartlink" href="/cart" hidden>View cart</a>
  </body></html>`,
  "/cart": `<html><body><h1>Your cart</h1><p>Ceramic Mug × 1</p><p>Subtotal 49,90 €</p><a href="/checkout">Proceed to checkout</a></body></html>`,
  "/checkout": `<html><body><h1>Checkout</h1><form onsubmit="event.preventDefault();fetch('/pay',{method:'POST'})">
    <label>Email <input name="email" type="email" autocomplete="email"></label>
    <label>Full name <input name="fullname"></label>
    <label>Postal code <input name="zip" autocomplete="shipping postal-code"></label>
    <p>Shipping 4,95 €</p><p>Total 54,85 €</p>
    <button type="submit">Place order</button></form></body></html>`,
  "/silent": `<html><body><h1>Mug</h1><p>49,90 €</p><button onclick="window.__added=1">Add to cart</button></body></html>`,
  "/wall": `<html><body><h1>Mug</h1><p>10,00 €</p><a href="/login-checkout">Add to cart</a></body></html>`,
  "/login-checkout": `<html><body><h1>Sign in to check out</h1><form><label>Email <input type="email" name="email" autocomplete="email"></label>
    <label>Password <input type="password" name="pw" autocomplete="current-password"></label><button>Sign in</button></form></body></html>`,
};

export interface Shop {
  base: string;
  payHits: number;
  close(): void;
}

export async function startShop(): Promise<Shop> {
  const shop = { base: "", payHits: 0, close: () => server.close() };
  const server: Server = createServer((req, res) => {
    if (req.url === "/pay") {
      shop.payHits++;
      return res.end("paid");
    }
    if (req.url === "/robots.txt") return res.end("User-agent: *\nAllow: /\n");
    const html = PAGES[req.url ?? ""];
    const style = "<style>body{font:16px system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1d1d1f}button,a{font:inherit}button{padding:8px 16px;border-radius:8px;border:1px solid #888;background:#111;color:#fff}select,input{font:inherit;padding:6px;margin:4px 0 12px;display:block}</style>";
    res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(html ? style + html : "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  shop.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return shop;
}
