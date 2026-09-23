#!/usr/bin/env node
import { parseArgs } from "node:util";
import { evaluate, type Report } from "./checks.js";
import { collect } from "./collect.js";

const HELP = `usage: muse-commerce-audit <url> [--json] [--user-agent UA] [--journey [--trace FILE]] [--muse] [--muse-bin PATH] [--model ID]

Loads <url> in headless Chromium and reports whether an AI shopping agent can
read and act on it. --journey runs the mystery shopper up to the pay button
(adds an item to a real cart; never types or pays). --muse also has a real Muse Code agent browse the page itself
through this repo's commerce_audit MCP server (needs the muse CLI).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean" },
    "user-agent": { type: "string" },
    muse: { type: "boolean" },
    journey: { type: "boolean" },
    trace: { type: "string" },
    "muse-bin": { type: "string" },
    model: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || positionals.length !== 1) {
  console.log(HELP);
  process.exit(values.help ? 0 : 2);
}

if (values.journey) {
  const { runJourney } = await import("./shopper.js");
  const j = await runJourney(positionals[0], { userAgent: values["user-agent"], tracePath: values.trace });
  if (values.json) console.log(JSON.stringify(j, null, 2));
  else {
    console.log(`\n${j.url}\nMystery-shopper journey: ${j.score}/100${j.reachedPaymentBoundary ? " (reached payment boundary, not paid)" : ""}\n`);
    const icon = { passed: "✓", failed: "✗", skipped: "-" };
    for (const s of j.steps) console.log(`  ${icon[s.status]} [${s.id}] ${s.detail}`);
    if (j.overlaysDismissed.length) console.log(`\n  Overlays dismissed: ${j.overlaysDismissed.join(", ")}`);
    if (values.trace) console.log(`  Trace: npx playwright show-trace ${values.trace}`);
  }
  process.exit(j.steps.some((s) => s.status === "failed") ? 1 : 0);
}

const evidence = await collect(positionals[0], { userAgent: values["user-agent"] });
const report = evaluate(evidence);
let museReply: string | undefined;
if (values.muse) {
  const { askMuse, findMuse } = await import("./muse.js");
  const bin = findMuse(values["muse-bin"]);
  if (!bin) {
    console.error("--muse needs the Muse Code CLI: put `muse` on PATH or pass --muse-bin PATH.");
    process.exit(3);
  }
  museReply = await askMuse(positionals[0], { museBin: bin, modelId: values.model });
}

if (values.json) console.log(JSON.stringify({ ...report, museReply }, null, 2));
else print(report, museReply);
process.exit(report.findings.some((f) => f.severity === "error") ? 1 : 0);

function print(r: Report, reply?: string) {
  console.log(`\n${r.url}\nAgent-readiness score: ${r.score}/100\n`);
  for (const p of r.products) console.log(`Product: ${p.name} — ${p.price} ${p.currency ?? ""} ${p.availability ?? ""}`);
  const icon = { error: "✗", warning: "!", info: "i" };
  for (const f of r.findings) console.log(`  ${icon[f.severity]} [${f.id}] ${f.message}`);
  if (r.findings.length === 0) console.log("  ✓ no findings");
  if (reply) console.log(`\nMuse assessment:\n${reply}`);
}
