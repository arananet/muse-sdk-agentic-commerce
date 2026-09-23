---
name: agentic-commerce-audit
description: Audit how ready a shop page is for standards-following AI shopping agents (discover, understand, buy), using real headless Chromium. Use when the user gives a product or shop URL and asks about agent readiness or agentic commerce.
metadata:
  short-description: Agent-readiness audit of a shop URL in Chromium
argument-hint: "<product-url>"
---
# Agentic commerce audit

The argument is a product page URL.

1. Call `mcp__commerce_audit__agent_view` with the URL. Act as a shopping agent:
   from the ARIA snapshot and JSON-LD alone, try to identify product name, price,
   currency, availability and the control you would press to buy. Say plainly
   what you could not determine.
2. Call `mcp__commerce_audit__agent_view` again with
   `user_agent: "meta-externalagent/1.1"` and report any difference (blocking,
   different content).
3. Call `mcp__commerce_audit__audit_page` with the URL for the heuristic findings.
4. Mystery shopper: drive the purchase yourself with `shop_open` (the URL),
   then `shop_view`, `shop_click` (role + exact accessible name from the snapshot)
   and `shop_select`, using only what the ARIA snapshot tells you: dismiss overlays,
   pick a variant, add to cart, confirm it worked, go to checkout. Stop when you
   see a pay / place-order control (`shop_click` refuses it anyway), then `shop_close`.
   Note every point where you hesitated or guessed. Then call `mystery_shop` with
   the URL for the deterministic journey and compare it with your own walk.
5. Answer with: a verdict of **agent-readiness against public standards**
   (ready / partially ready / not ready) — never call it "Muse-ready": you are a
   second opinion, not Meta's shopping agent —, what you as an
   agent perceived, and the five most important concrete fixes, most important first.

Never type personal or payment data, submit forms or pay. Adding to cart is allowed.
The shopper may accept cookies to dismiss a blocking banner when no reject option exists.
The payment boundary is best-effort (matching pay / place-order names): if `shop_click`
returns a `warning` about payment inputs, you are at the boundary even if the button said
"Continue" — stop and `shop_close`. Do not use other tools.
