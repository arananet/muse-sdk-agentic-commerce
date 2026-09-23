/** Sends audit evidence to a real Muse Code agent via @muse-code/sdk and returns its reply text. */
import { MuseClient } from "@muse-code/sdk";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Evidence } from "./collect.js";
import type { Report } from "./checks.js";

export interface MuseOptions {
  museBin?: string;
  modelId?: string;
  onStderr?: (chunk: string) => void;
}

export function buildPrompt(ev: Evidence, report: Report): string {
  return [
    "You are acting as an AI shopping agent (like Meta Muse) that must buy the product on this page for a user.",
    "Below is what headless Chromium observed. Do NOT use tools; reason only over this evidence.",
    "Answer: (1) could you identify the product, price, currency and availability unambiguously?",
    "(2) could you locate and operate the add-to-cart / buy control? (3) the top 5 concrete fixes, most important first.",
    "",
    `URL: ${ev.finalUrl}  HTTP ${ev.status}  title: ${ev.title}`,
    `Heuristic findings: ${JSON.stringify(report.findings)}`,
    `JSON-LD: ${JSON.stringify(ev.jsonLd).slice(0, 8000)}`,
    `Purchase controls: ${JSON.stringify(ev.purchaseControls)}`,
    "Accessibility tree (ARIA snapshot):",
    ev.ariaSnapshot.slice(0, 12000),
  ].join("\n");
}

export async function askMuse(ev: Evidence, report: Report, opts: MuseOptions = {}): Promise<string> {
  const client = await MuseClient.spawn({
    museBin: opts.museBin ?? "muse",
    args: ["serve"],
    clientInfo: { name: "muse-commerce-audit", version: "0.1.0" },
    onStderr: opts.onStderr,
  });
  try {
    const session = await client.startSession({
      workspaceRoot: process.cwd(),
      ...(opts.modelId ? { modelId: opts.modelId } : {}),
    });
    // Read-only analysis: deny every tool call the agent attempts.
    session.onApproval((request) => {
      const deny = request.availableChoices.find((c) => c.decision === "denied" || c.decision === "abort");
      if (!deny) throw new Error(`no deny choice offered for ${request.toolName}`);
      return { choiceId: deny.choiceId };
    });
    const turn = await session.sendUserTurn({ input: [{ type: "text", text: buildPrompt(ev, report) }] });
    const replies = new Map<string, string>();
    for await (const item of turn.items()) {
      if (item.kind === "agentMessage" && item.text) replies.set(item.itemId, item.text);
    }
    await turn.completed;
    return [...replies.values()].join("\n\n");
  } finally {
    await client.close();
  }
}

/** Resolves the muse binary (explicit path or PATH lookup); undefined when not installed. */
export function findMuse(explicit?: string): string | undefined {
  const candidates = explicit ? [explicit] : (process.env.PATH ?? "").split(delimiter).map((d) => join(d, "muse"));
  return candidates.find((c) => {
    try {
      accessSync(c, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
