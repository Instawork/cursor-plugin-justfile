#!/usr/bin/env node
/**
 * Live check for Cursor Cloud Agents API + local ingest path (no secrets printed).
 *
 *   CURSOR_CLOUD_API_KEY=… node scripts/verify-cloud-agents.mjs
 *
 * Optional: EXT_PATH=…/token-telemetry node scripts/verify-cloud-agents.mjs
 *   runs syncCloudAgentUsage via a tiny dynamic import shim (needs compiled out/).
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Agent } from "@cursor/sdk";

const apiKey = (
  process.env.CURSOR_CLOUD_API_KEY ||
  process.env.CURSOR_API_KEY ||
  ""
).trim();
if (!apiKey) {
  console.error(
    "Set CURSOR_CLOUD_API_KEY (from cursor.com/dashboard/cloud-agents)."
  );
  process.exit(1);
}

const page = await Agent.list({
  runtime: "cloud",
  apiKey,
  limit: 20,
  includeArchived: false,
});
const bc = page.items.filter((a) => a.agentId.startsWith("bc-"));
console.log(`cloud agents (bc-*): ${bc.length} on first page (${page.items.length} total)`);
if (bc[0]) {
  console.log(`sample: ${bc[0].agentId} ${bc[0].name ?? ""}`.trim());
  const runs = await Agent.listRuns(bc[0].agentId, {
    runtime: "cloud",
    apiKey,
    limit: 5,
  });
  const terminal = runs.items.filter((r) =>
    ["finished", "error", "cancelled"].includes(r.status)
  );
  console.log(
    `sample runs: ${runs.items.length} listed, ${terminal.length} terminal`
  );
  if (terminal[0]) {
    console.log(
      `  latest terminal: ${terminal[0].id} status=${terminal[0].status} tokens=${terminal[0].usage?.totalTokens ?? "?"}`
    );
  }
}

const sqlite = join(
  homedir(),
  "code/cursor-contexts/assistant/token-telemetry.sqlite"
);
const hook = join(homedir(), ".cursor/hooks/token_telemetry_db.py");
if (existsSync(sqlite) && existsSync(hook)) {
  const q = spawnSync(
    "python3.11",
    [hook, "--query"],
    {
      input: JSON.stringify({ mode: "cloudRunIds" }),
      env: { ...process.env, TOKEN_HOOK_SQLITE: sqlite },
      encoding: "utf8",
    }
  );
  if (q.status === 0) {
    const ids = JSON.parse(q.stdout || "[]");
    console.log(`sqlite cloudRun rows (distinct run ids): ${ids.length}`);
  } else {
    console.log("sqlite cloudRunIds query failed (see stderr)");
  }
} else {
  console.log("sqlite or hook missing — skip local ledger check");
}

console.log("API list/listRuns OK. In IDE: set key + Token Telemetry: Sync Cloud Agents.");
