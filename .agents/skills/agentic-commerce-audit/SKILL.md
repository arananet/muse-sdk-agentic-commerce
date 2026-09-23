---
name: agentic-commerce-audit
description: Audit whether a shop page can be discovered, understood and bought from by an AI shopping agent such as Meta Muse, using real headless Chromium. Use when the user gives a product or shop URL and asks about agent readiness, agentic commerce or Muse compatibility.
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
4. Answer with: a verdict (ready / partially ready / not ready), what you as an
   agent perceived, and the five most important concrete fixes, most important first.

Do not submit forms, add items to a cart or buy anything. Do not use other tools.
