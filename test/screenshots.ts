/** Regenerates docs/screenshots from real CLI runs and the fixture shop: `npm run screenshots`. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startShop } from "./fixture-shop.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = `${root}docs/screenshots`;
mkdirSync(out, { recursive: true });

const shop = await startShop();
const browser = await chromium.launch();
const cli = async (...args: string[]) => {
  try {
    return (await promisify(execFile)(process.execPath, [`${root}dist/src/cli.js`, ...args], { encoding: "utf8" })).stdout;
  } catch (e) {
    return (e as { stdout: string }).stdout; // exit 1 = findings, output still valid
  }
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const colour = (s: string) =>
  esc(s)
    .replace(/^(\s+✓.*)$/gm, '<span style="color:#3fb950">$1</span>')
    .replace(/^(\s+✗.*)$/gm, '<span style="color:#f85149">$1</span>')
    .replace(/^(\s+!.*)$/gm, '<span style="color:#d29922">$1</span>');

async function terminal(file: string, cmd: string, output: string) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 200 }, deviceScaleFactor: 2 });
  await page.setContent(`<body style="margin:0;background:#0d1117;padding:24px;font:14px/1.5 ui-monospace,Menlo,monospace;color:#c9d1d9">
    <div style="color:#8b949e">$ ${esc(cmd)}</div><pre style="margin:0;white-space:pre-wrap">${colour(output.replace(shop.base, "https://shop.example"))}</pre></body>`);
  await page.screenshot({ path: `${out}/${file}`, fullPage: true });
  await page.close();
}

try {
  await terminal("audit.png", "muse-commerce-audit https://shop.example/pdp", (await cli(`${shop.base}/pdp`)).replaceAll(shop.base, "https://shop.example"));
  await terminal(
    "journey.png",
    "muse-commerce-audit --journey https://shop.example/pdp",
    (await cli("--journey", `${shop.base}/pdp`)).replaceAll(shop.base, "https://shop.example"),
  );

  const page = await browser.newPage({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 2 });
  await page.goto(`${shop.base}/checkout`);
  await page.getByRole("button", { name: "Place order" }).evaluate((el) => {
    (el as HTMLElement).style.outline = "4px solid #f85149";
    el.insertAdjacentHTML("afterend", '<span style="color:#f85149;font-weight:600;margin-left:12px">⛔ payment boundary — never pressed</span>');
  });
  await page.screenshot({ path: `${out}/shop-boundary.png` });
} finally {
  await browser.close();
  shop.close();
}
