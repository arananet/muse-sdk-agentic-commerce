/**
 * Drives a real Muse Code session via @muse-code/sdk: the agent browses the shop itself through the
 * project's `commerce_audit` MCP server (headless Chromium) and the `agentic-commerce-audit` skill.
 */
import { MuseClient, readSessionDurability, spawnMspConnection } from "@muse-code/sdk";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL = "agentic-commerce-audit";
export const TOOL_PREFIX = "mcp__commerce_audit__";
/** Repository root: holds .mcp.json and .agents/skills, so it is the session's workspace. */
export const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface MuseOptions {
  museBin: string;
  modelId?: string;
  onStderr?: (chunk: string) => void;
}

/** Approves our read-only Chromium tools once; denies everything else. */
export function decide(toolName: string, choices: readonly { choiceId: string; decision: string; scope: string }[]) {
  const wanted = toolName.startsWith(TOOL_PREFIX) ? ["approved"] : ["denied", "abort"];
  const pick = choices.find((c) => wanted.includes(c.decision) && (c.decision !== "approved" || c.scope === "once"));
  if (!pick) {
    const offered = choices.map((c) => `${c.decision}/${c.scope}`).join(", ");
    throw new Error(
      `no ${wanted.join("/")} choice offered for ${toolName} (offered: ${offered}); ` +
        `this policy targets the approval choices of @muse-code/sdk 1.3.0 / Muse Code 1.3.x`,
    );
  }
  return { choiceId: pick.choiceId };
}

export async function askMuse(url: string, opts: MuseOptions): Promise<string> {
  const msp = await spawnMspConnection({
    command: opts.museBin,
    // Trust is scoped to WORKSPACE (this repository), whose .mcp.json and skill we ship; validated
    // against Muse Code 1.3.0 to load the skill without an interactive trust step.
    args: ["serve", "--trust-workspace"],
    cwd: WORKSPACE,
    onStderr: opts.onStderr,
  }).initialize({ clientInfo: { name: "muse_commerce_audit", version: "0.1.0" } });
  const client = new MuseClient(msp.connection, { durability: readSessionDurability(msp.initializeResult), host: msp });
  try {
    const session = await client.startSession({
      workspaceRoot: WORKSPACE,
      ...(opts.modelId ? { modelId: opts.modelId } : {}),
    });
    session.onApproval((req) => decide(req.toolName, req.availableChoices));

    const listed = await msp.connection.request("skill/list", { sessionId: session.sessionId });
    const skill = (listed.skills as { selector: string }[]).find((s) => s.selector === SKILL);
    if (!skill) {
      throw new Error(
        `skill ${SKILL} not loaded from ${WORKSPACE} although the host was started with --trust-workspace. ` +
          `Check \`muse skills list\` there and that \`npm run build\` has produced dist/.`,
      );
    }
    const turn = await session.sendUserTurn({ input: [{ type: "skill", selector: skill.selector, arguments: url }] });
    const replies = new Map<string, string>();
    for await (const item of turn.items()) {
      if (item.kind === "agentMessage" && item.text) replies.set(item.itemId, item.text);
    }
    const outcome = await turn.completed;
    if (outcome.kind === "completed" && outcome.params.terminal === "failed") {
      throw new Error(`Muse turn failed: ${JSON.stringify(outcome.params)}`);
    }
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
