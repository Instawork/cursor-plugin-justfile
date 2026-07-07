import * as fs from "fs";
import { defaultSqlitePath } from "./dbQuery";
import { logTelemetryError } from "./dbLog";
import { hookExecCwd, resolveHookScript } from "./hookPaths";
import { hookPythonBin } from "./installHooks";
import { execPythonScript } from "./pythonExec";

export type IngestRecord = {
  event?: "cloudRun" | "agentTurn";
  run_id: string;
  agent_id?: string;
  model?: string;
  at?: string;
  conversation?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    total_tokens?: number;
  };
};

let ingestTimeoutMs = 120_000;

export function setIngestTimeoutMs(ms: number): void {
  ingestTimeoutMs = Math.max(5_000, Math.min(ms, 600_000));
}

/** Append usage rows via token_count_hook.py --ingest (SQLite + optional CSV). */
export async function ingestUsageRecords(
  extensionPath: string,
  records: IngestRecord[]
): Promise<number> {
  if (!records.length) {
    return 0;
  }
  const script = resolveHookScript(extensionPath, "token_count_hook.py");
  if (!fs.existsSync(script)) {
    throw new Error(`Token hook script not found: ${script}`);
  }
  const cwd = hookExecCwd(script);
  const env = { ...process.env };
  if (!env.TOKEN_HOOK_SQLITE?.trim()) {
    env.TOKEN_HOOK_SQLITE = defaultSqlitePath();
  }
  const result = await execPythonScript(script, ["--ingest"], {
    cwd,
    env,
    input: JSON.stringify(records),
    maxBuffer: 16 * 1024 * 1024,
    timeoutMs: ingestTimeoutMs,
  });
  if (!result.ok) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n");
    logTelemetryError(
      result.timedOut
        ? `token_count_hook.py --ingest timed out (${ingestTimeoutMs}ms)`
        : `token_count_hook.py --ingest failed: ${result.error}`,
      detail
    );
    throw new Error(result.timedOut ? "Ingest timed out" : result.error);
  }
  const match = /Ingested (\d+) row/.exec(result.stdout);
  return match ? Number(match[1]) : records.length;
}
