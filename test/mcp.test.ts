import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "../src/muse.js";

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
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["agent_view", "audit_page"]);
    assert.ok(list.result.tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint));

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
