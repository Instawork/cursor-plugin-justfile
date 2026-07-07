import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logTelemetryError, logTelemetryInfo, logTelemetryWarn } from "./dbLog";
import { hookExecCwd, resolveHookScript } from "./hookPaths";
import { execPythonScript } from "./pythonExec";

import type { TelemetryRow } from "./telemetry";

export function defaultSqlitePath(): string {
  const raw = process.env.TOKEN_HOOK_SQLITE?.trim();
  if (raw) {
    return raw.startsWith("~")
      ? path.join(os.homedir(), raw.slice(1).replace(/^\//, ""))
      : raw;
  }
  return path.join(
    os.homedir(),
    "code/cursor-contexts/assistant",
    "token-telemetry.sqlite"
  );
}

let dbQueryTimeoutMs = 120_000;

export function setDbQueryTimeoutMs(ms: number): void {
  dbQueryTimeoutMs = Math.max(5_000, Math.min(ms, 600_000));
}

function pythonDbEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.TOKEN_HOOK_SQLITE?.trim()) {
    env.TOKEN_HOOK_SQLITE = defaultSqlitePath();
  }
  return env;
}

async function runDbScript(
  extensionPath: string,
  args: string[],
  input?: string
): Promise<{ stdout: string } | null> {
  const script = resolveHookScript(extensionPath, "token_telemetry_db.py");
  if (!fs.existsSync(script)) {
    logTelemetryWarn(`DB script missing: ${script}`);
    return null;
  }
  const cwd = hookExecCwd(script);
  const label = `token_telemetry_db.py ${args.join(" ")}`;
  const result = await execPythonScript(script, args, {
    cwd,
    env: pythonDbEnv(),
    input,
    timeoutMs: dbQueryTimeoutMs,
  });
  if (!result.ok) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n");
    logTelemetryError(
      result.timedOut
        ? `${label} timed out (${dbQueryTimeoutMs}ms)`
        : `${label} failed: ${result.error}`,
      detail
    );
    return null;
  }
  if (result.stderr.trim()) {
    logTelemetryInfo(`${label}: ${result.stderr.trim()}`);
  }
  return { stdout: result.stdout };
}

export async function migrateSqliteIfNeeded(
  extensionPath: string
): Promise<void> {
  const out = await runDbScript(extensionPath, ["--migrate-csv-if-needed"]);
  if (out?.stdout.trim()) {
    logTelemetryInfo(out.stdout.trim());
  }
}

export async function queryTurnsFromSqlite(
  extensionPath: string,
  options: { limit?: number; since?: string } = {}
): Promise<TelemetryRow[] | null> {
  const sqlitePath = defaultSqlitePath();
  if (!fs.existsSync(sqlitePath)) {
    return null;
  }
  const out = await runDbScript(
    extensionPath,
    ["--query"],
    JSON.stringify({
      limit: options.limit ?? 10_000,
      since: options.since,
      includeRollups: false,
    })
  );
  if (out === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(out.stdout) as TelemetryRow[];
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logTelemetryError("SQLite query returned invalid JSON", msg);
    return null;
  }
}

export async function queryCloudRunIdsFromSqlite(
  extensionPath: string
): Promise<Set<string> | null> {
  const sqlitePath = defaultSqlitePath();
  if (!fs.existsSync(sqlitePath)) {
    return null;
  }
  const out = await runDbScript(
    extensionPath,
    ["--query"],
    JSON.stringify({ mode: "cloudRunIds" })
  );
  if (out === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(out.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const ids = new Set<string>();
    for (const item of parsed) {
      if (typeof item === "string" && item.trim()) {
        ids.add(item.trim());
      }
    }
    return ids;
  } catch {
    return null;
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function cloudRunIdsFromCsv(csvPath: string): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(csvPath)) {
    return ids;
  }
  const text = fs.readFileSync(csvPath, "utf8").trim();
  if (!text) {
    return ids;
  }
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const eventIdx = header.indexOf("event");
  const genIdx = header.indexOf("generation_id");
  if (eventIdx < 0 || genIdx < 0) {
    return ids;
  }
  for (const line of lines.slice(1)) {
    if (!line) {
      continue;
    }
    const cells = parseCsvLine(line);
    if (cells[eventIdx] !== "cloudRun") {
      continue;
    }
    const id = (cells[genIdx] ?? "").trim();
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

export async function knownCloudRunIds(
  extensionPath: string,
  csvPath: string
): Promise<Set<string>> {
  const fromSql = await queryCloudRunIdsFromSqlite(extensionPath);
  if (fromSql !== null) {
    return fromSql;
  }
  return cloudRunIdsFromCsv(csvPath);
}
