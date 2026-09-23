# muse-commerce-audit

An auditor that opens your shop in **real headless Chromium** (Playwright) and checks
whether an AI shopping agent such as **Meta Muse** can discover, understand and act on
the page — **without the Universal Commerce Protocol**, using only public web
standards. It can also let a **real Muse Code agent** browse and shop the page itself
through the official [`@muse-code/sdk`](https://www.npmjs.com/package/@muse-code/sdk)
(developer preview).

> Honest caveat: Meta has not published the rules its consumer Muse agent applies when
> browsing. The checks are heuristics based on standards (robots.txt RFC 9309,
> schema.org, the ARIA accessibility tree), not Muse's internal logic. The public SDK
> drives **Muse Code** (the agent) over MSP; it does not expose the consumer product's
> browser.

## What it checks

| Check | What it looks at |
|---|---|
| `bot-wall`, `http-status` | 403/429/CAPTCHA/Cloudflare/DataDome when loaded by headless Chromium |
| `robots-*` | Whether robots.txt blocks `meta-externalagent`, `meta-externalfetcher`, `facebookexternalhit`, `FacebookBot` |
| `product-schema`, `offer-*`, `product-*` | `Product`/`Offer` JSON-LD: name, price, currency, availability, image, sku/gtin |
| `price-mismatch` | JSON-LD price is visible in the rendered text |
| `no-js`, `no-js-text` | Product data present in the server HTML without running JavaScript |
| `purchase-control`, `unnamed-control` | An "Add to cart / Buy" control findable by ARIA role + accessible name |
| `open-graph` | Open Graph metadata |

## Usage

```sh
npm install
npm run build
node dist/src/cli.js https://your-shop.example/product/123
node dist/src/cli.js --json https://your-shop.example/product/123
node dist/src/cli.js --user-agent "meta-externalagent/1.1" https://...
```

Exits with code `1` when any error is found (handy in CI).

### Mystery shopper (`--journey`)

Walks the purchase in Chromium **using only ARIA roles and accessible names**, the way
an agent would: dismiss overlays (cookies, popups) → choose a variant → "Add to cart" →
verify machine-readable feedback (URL change, `aria-live`, `role=status`, dialog) → go
to cart/checkout → measure guest checkout, `autocomplete` coverage and price drift
(product page → total). **It stops at the pay button and never presses it; it never
types into forms.** It does add an item to a real cart.

```sh
node dist/src/cli.js --journey --trace trace.zip https://your-shop.example/product/123
npx playwright show-trace trace.zip   # step-by-step replay
```

### With real Muse Code: Muse browses with Chromium

Following the [developer preview docs](https://meta-models.github.io/muse-code-sdk/)
(Extending Muse Code → MCP servers / Skills), the repo ships:

- `.mcp.json` → stdio MCP server `commerce_audit` (`dist/src/mcp-server.js`) with tools:
  `agent_view` and `audit_page` (read-only), `mystery_shop` (deterministic journey), and
  `shop_open` / `shop_view` / `shop_click` / `shop_select` / `shop_close` so **Muse drives
  the purchase step by step** in a persistent tab; `shop_click` refuses payment controls.
- `.agents/skills/agentic-commerce-audit/SKILL.md` → a skill that guides Muse: view the
  page, repeat with the `meta-externalagent` UA, audit, shop it itself, and give a
  verdict with fixes.

Requirements: the `muse` CLI 1.3.x, logged in; `npm run build`; and a trusted workspace
(project `.mcp.json` files and skills only load in trusted workspaces):

```sh
muse --trust-workspace      # or open `muse` here once and pick "Trust and continue"
node dist/src/cli.js --muse https://your-shop.example/product/123
```

`--muse` uses `@muse-code/sdk`: it spawns `muse serve`, starts a session with this repo
as `workspaceRoot`, checks `skill/list`, invokes the skill with a `skill` input part,
**approves only `mcp__commerce_audit__*` tools** (once) and denies everything else, then
prints the reply. In the Muse TUI: `/agentic-commerce-audit https://...`.

## Tests

```sh
npm test
```

Starts a local HTTP server with fixture pages and a fixture shop and audits them in real
Chromium; also drives the MCP server over a stdio pipe and checks the approval policy.
The end-to-end `--muse` mode has no automated test: it needs the `muse` binary.

## Layout

- `src/collect.ts` — Chromium: navigation, robots.txt, JSON-LD, no-JS render, ARIA controls
- `src/checks.ts` — rules and scoring
- `src/robots.ts` — robots.txt parser
- `src/shopper.ts` — mystery shopper
- `src/muse.ts` — `@muse-code/sdk` integration
- `src/mcp-server.ts` — stdio MCP server for Muse Code
- `.openspec/specs/` — specs
