import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "../src/muse.js";
import { startShop } from "./fixture-shop.js";

const SERVER = fileURLToPath(new URL("../src/mcp-server.js", import.meta.url));

test("MCP server over stdio: initialize, tools/list, agent_view in real Chromium", async () => {
  const shop = createServer((req, res) =>
    res.end(req.url === "/robots.txt" ? "User-agent: *\nAllow: /" : `<title>Shop</title><h1>Mug</h1><button>Add to cart</button>`),
  );
  await new Promise<void>((r) => shop.listen(0, "127.0.0.1", r));
  const port = (shop.address() as { port: number }).port;

  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const rpc = async (id: number | undefined, method: string, params: object = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) + "\n");
    if (id === undefined) return undefined;
    return JSON.parse((await lines.next()).value as string);
  };
  try {
    const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    await rpc(undefined, "notifications/initialized");
    const list = await rpc(2, "tools/list");
    const names = list.result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(names, ["agent_view", "audit_page", "mystery_shop", "shop_open", "shop_view", "shop_click", "shop_select", "shop_close"]);
    const readOnly = list.result.tools.filter((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint);
    assert.deepEqual(readOnly.map((t: { name: string }) => t.name), ["agent_view", "audit_page", "shop_open", "shop_view", "shop_close"]);

    const view = await rpc(3, "tools/call", { name: "agent_view", arguments: { url: `http://127.0.0.1:${port}/p` } });
    const body = JSON.parse(view.result.content[0].text);
    assert.equal(body.status, 200);
    assert.deepEqual(body.purchaseControls, [{ role: "button", name: "Add to cart" }]);
    assert.match(body.ariaSnapshot, /heading "Mug"/);

    const bad = await rpc(4, "tools/call", { name: "agent_view", arguments: { url: "file:///etc/passwd" } });
    assert.equal(bad.result.isError, true);
    assert.equal((await rpc(5, "resources/list")).error.code, -32601);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
    shop.close();
  }
});

function mcp() {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const call = async (name: string, args: object = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    const res = JSON.parse((await lines.next()).value as string).result;
    return { isError: res.isError === true, text: res.content[0].text as string };
  };
  const close = async () => {
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
  };
  return { call, close };
}

test("MCP stepwise shopping keeps state across calls and refuses to pay", async () => {
  const shop = await startShop();
  const { call, close } = mcp();
  try {
    assert.equal((await call("shop_view")).isError, true, "no tab before shop_open");
    let v = await call("shop_open", { url: `${shop.base}/pdp` });
    assert.match(v.text, /button \\"Accept all\\"/);
    await call("shop_click", { role: "button", name: "Accept all" });
    v = await call("shop_select", { name: "Size", option: "M" });
    assert.equal(v.isError, false, v.text);
    v = await call("shop_click", { role: "button", name: "Add to cart" });
    assert.match(v.text, /Added to cart \(1\)/);
    await call("shop_click", { role: "link", name: "View cart" });
    v = await call("shop_click", { role: "link", name: "Proceed to checkout" });
    assert.match(JSON.parse(v.text).url, /\/checkout$/);
    const refused = await call("shop_click", { role: "button", name: "Place order" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /refused/);
    assert.equal(shop.payHits, 0);

    const journey = JSON.parse((await call("mystery_shop", { url: `${shop.base}/pdp` })).text);
    assert.equal(journey.reachedPaymentBoundary, true);
    assert.equal(shop.payHits, 0);
    await call("shop_close");
  } finally {
    await close();
    shop.close();
  }
});

test("approval policy: approve our MCP tools once, deny everything else", () => {
  const choices = [
    { choiceId: "allow_once", decision: "approved", scope: "once" },
    { choiceId: "allow_session", decision: "approvedForSession", scope: "session" },
    { choiceId: "deny", decision: "denied", scope: "once" },
  ];
  assert.equal(decide("mcp__commerce_audit__agent_view", choices).choiceId, "allow_once");
  assert.equal(decide("shell", choices).choiceId, "deny");
  assert.equal(decide("mcp__other__x", choices).choiceId, "deny");
  assert.throws(() => decide("shell", [choices[0]]));
});
