import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isBillableTurnEvent } from "./billableEvents";
import type { CloudSyncStatus } from "./cloudSyncTypes";
import {
  defaultSqlitePath,
  queryTurnsFromSqlite,
} from "./dbQuery";
import { modelEffectiveUsdPerM, normalizePriceMode } from "./modelPricing";
import {
  buildUsageCostInsights,
  type UsageCostInsights,
} from "./usageAnalytics";

const CANONICAL_CSV_HEADER = [
  "at",
  "event",
  "model",
  "conversation_id",
  "generation_id",
  "input_uncached_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "total_tokens",
  "cost_usd",
  "cumulative_total_tokens",
  "cumulative_output_tokens",
  "cumulative_cost_usd",
  "context_usage_percent",
  "conversation",
] as const;

const INT_COLS = new Set([
  "input_uncached_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "total_tokens",
  "cumulative_total_tokens",
  "cumulative_output_tokens",
]);

const FLOAT_COLS = new Set([
  "cost_usd",
  "cumulative_cost_usd",
  "context_usage_percent",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TelemetryRow = Record<string, string | number | null | boolean>;

export type UsageDayTotals = {
  cost_usd: number;
  total_tokens: number;
  output_tokens: number;
  turn_count: number;
};

export type { UsageCostInsights } from "./usageAnalytics";

export type UsagePayload = {
  generatedAt: string;
  csvPath: string;
  sqlitePath: string;
  dataSource: "sqlite" | "csv";
  hooksInstalled: boolean;
  priceMode: string;
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  state: Record<string, unknown>;
  conversationTitles: Record<string, string>;
  lastTurn: TelemetryRow | null;
  rows: TelemetryRow[];
  dayTotals: UsageDayTotals;
  dailySnapshot: TelemetryRow | null;
  costMismatchCount: number;
  costInsights: UsageCostInsights;
  cloudSync: CloudSyncStatus | null;
};

let telemetryExtensionPath = "";
let telemetryQueryLimit = 10_000;

export function initTelemetryDataSource(
  extensionPath: string,
  queryLimit?: number
): void {
  telemetryExtensionPath = extensionPath;
  if (queryLimit !== undefined && queryLimit > 0) {
    telemetryQueryLimit = queryLimit;
  }
}

export function defaultPaths(): {
  csvPath: string;
  statePath: string;
  titlesPath: string;
  sqlitePath: string;
} {
  const dir = path.join(os.homedir(), "code/cursor-contexts/assistant");
  return {
    csvPath: path.join(dir, "token-telemetry.csv"),
    statePath: path.join(dir, "token-hook-state.json"),
    titlesPath: path.join(dir, "token-conversation-titles.json"),
    sqlitePath: defaultSqlitePath(),
  };
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

function rowToRecord(cells: string[], keys: readonly string[]): TelemetryRow {
  const padded = [...cells];
  while (padded.length < keys.length) {
    padded.push("");
  }
  const rec: TelemetryRow = {};
  keys.forEach((key, i) => {
    const raw = padded[i] ?? "";
    if (raw === "") {
      rec[key] = null;
      return;
    }
    if (INT_COLS.has(key)) {
      rec[key] = parseInt(raw, 10) || 0;
    } else if (FLOAT_COLS.has(key)) {
      rec[key] = parseFloat(raw) || 0;
    } else {
      rec[key] = raw;
    }
  });
  return rec;
}

function csvHeaderKeys(firstLine: string): string[] {
  const parsed = parseCsvLine(firstLine).map((h) => h.trim());
  if (!parsed.length) {
    return [...CANONICAL_CSV_HEADER];
  }
  if (!parsed.includes("conversation")) {
    return [...parsed, "conversation"];
  }
  return parsed;
}

export function loadRows(csvPath: string): TelemetryRow[] {
  return loadRowsFromCsv(csvPath);
}

export async function loadRowsAsync(csvPath: string): Promise<TelemetryRow[]> {
  const sqlitePath = defaultSqlitePath();
  if (telemetryExtensionPath && fs.existsSync(sqlitePath)) {
    const fromDb = await queryTurnsFromSqlite(telemetryExtensionPath, {
      limit: telemetryQueryLimit,
    });
    if (fromDb !== null) {
      return fromDb;
    }
  }
  return loadRowsFromCsv(csvPath);
}

function loadRowsFromCsv(csvPath: string): TelemetryRow[] {
  if (!fs.existsSync(csvPath)) {
    return [];
  }
  const text = fs.readFileSync(csvPath, "utf8").trim();
  if (!text) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const keys = csvHeaderKeys(lines[0]);
  const body = lines.slice(1);
  return body.filter(Boolean).map((line) => rowToRecord(parseCsvLine(line), keys));
}

function loadConversationTitles(titlesPath: string): Record<string, string> {
  if (!fs.existsSync(titlesPath)) {
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(titlesPath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) {
        out[key] = val.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function normalizeConversationLabel(
  raw: unknown,
  conversationId?: string | null,
  titles?: Record<string, string>
): string {
  const fromRow = typeof raw === "string" ? raw.trim() : "";
  if (fromRow && !UUID_RE.test(fromRow)) {
    return fromRow.length > 48 ? fromRow.slice(0, 45) + "…" : fromRow;
  }
  const id = conversationId ? String(conversationId) : "";
  if (id && titles?.[id]) {
    const t = titles[id];
    return t.length > 48 ? t.slice(0, 45) + "…" : t;
  }
  if (fromRow && UUID_RE.test(fromRow)) {
    return fromRow.slice(0, 8);
  }
  if (id) {
    return id.slice(0, 8);
  }
  return "—";
}

export function expectedCostUsd(
  row: TelemetryRow,
  priceMode: string,
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
): number {
  const uncached = Number(row.input_uncached_tokens || 0);
  const out = Number(row.output_tokens || 0);
  const cacheR = Number(row.cache_read_tokens || 0);
  const cacheW = Number(row.cache_write_tokens || 0);
  const mode = normalizePriceMode(priceMode);
  if (mode === "decomposed") {
    return (
      (uncached * rates.input +
        out * rates.output +
        cacheR * rates.cacheRead +
        cacheW * rates.cacheWrite) /
      1_000_000
    );
  }
  const total = uncached + cacheR + cacheW + out;
  if (mode === "model") {
    const model =
      typeof row.model === "string" || typeof row.model === "number"
        ? String(row.model)
        : "";
    return (total * modelEffectiveUsdPerM(model)) / 1_000_000;
  }
  return (total * rates.total) / 1_000_000;
}

function enrichRows(
  rows: TelemetryRow[],
  titles: Record<string, string>,
  priceMode: string,
  rates: UsagePayload["rates"]
): { rows: TelemetryRow[]; costMismatchCount: number } {
  let costMismatchCount = 0;
  const out = rows.map((row) => {
    const convId =
      typeof row.conversation_id === "string" ? row.conversation_id : null;
    const conversation = normalizeConversationLabel(
      row.conversation,
      convId,
      titles
    );
    const enriched: TelemetryRow = { ...row, conversation };
    if (isBillableTurnEvent(row.event)) {
      const expected = expectedCostUsd(row, priceMode, rates);
      const recorded = Number(row.cost_usd || 0);
      const mismatch = Math.abs(expected - recorded) > 0.0005;
      enriched.cost_expected_usd = Math.round(expected * 1_000_000) / 1_000_000;
      enriched.cost_mismatch = mismatch;
      if (mismatch) {
        costMismatchCount += 1;
      }
    }
    return enriched;
  });
  return { rows: out, costMismatchCount };
}

function loadState(statePath: string): Record<string, unknown> {
  if (!fs.existsSync(statePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hooksInstalledFlag(): boolean {
  return fs.existsSync(
    path.join(os.homedir(), ".cursor", "hooks", "token_count_hook.py")
  );
}

function priceRates() {
  return {
    priceMode: normalizePriceMode(process.env.TOKEN_HOOK_PRICE_MODE),
    rates: {
      input: parseFloat(process.env.TOKEN_HOOK_PRICE_INPUT_M || "0.25"),
      output: parseFloat(process.env.TOKEN_HOOK_PRICE_OUTPUT_M || "1.25"),
      cacheRead: parseFloat(process.env.TOKEN_HOOK_PRICE_CACHE_READ_M || "0.06"),
      cacheWrite: parseFloat(process.env.TOKEN_HOOK_PRICE_CACHE_WRITE_M || "0.25"),
      total: parseFloat(process.env.TOKEN_HOOK_PRICE_TOTAL_M || "0.35"),
    },
  };
}

function normalizeState(state: Record<string, unknown>): Record<string, unknown> {
  return {
    conversation_id: state.conversation_id ?? null,
    conversation_title: state.conversation_title ?? null,
    cumulative_total_tokens: state.cumulative_total_tokens ?? null,
    cumulative_output_tokens: state.cumulative_output_tokens ?? null,
    cumulative_cost_usd: state.cumulative_cost_usd ?? null,
    model: state.model ?? null,
  };
}

export function lastBillableTurn(
  rows: TelemetryRow[],
  conversationId?: string | null
): TelemetryRow | null {
  let turns = rows.filter((r) => isBillableTurnEvent(r.event));
  if (conversationId) {
    const scoped = turns.filter((r) => r.conversation_id === conversationId);
    if (scoped.length) {
      turns = scoped;
    }
  }
  return turns.length ? turns[turns.length - 1] : null;
}

/** @deprecated use lastBillableTurn */
export function lastAgentTurn(
  rows: TelemetryRow[],
  conversationId?: string | null
): TelemetryRow | null {
  return lastBillableTurn(rows, conversationId);
}

function utcDayKey(at: string | number | null | undefined): string {
  if (!at) {
    return new Date().toISOString().slice(0, 10);
  }
  const d = new Date(String(at));
  if (Number.isNaN(d.getTime())) {
    return String(at).slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

export function totalsForUtcDay(
  rows: TelemetryRow[],
  dayKey?: string
): UsageDayTotals {
  const day = dayKey ?? new Date().toISOString().slice(0, 10);
  let cost_usd = 0;
  let total_tokens = 0;
  let output_tokens = 0;
  let turn_count = 0;
  for (const r of rows) {
    const ev = String(r.event || "");
    if (ev !== "hourly" && !isBillableTurnEvent(ev)) {
      continue;
    }
    if (utcDayKey(r.at as string) !== day) {
      continue;
    }
    if (isBillableTurnEvent(ev)) {
      turn_count += 1;
    }
    cost_usd += Number(r.cost_usd || 0);
    total_tokens += Number(r.total_tokens || 0);
    output_tokens += Number(r.output_tokens || 0);
  }
  return { cost_usd, total_tokens, output_tokens, turn_count };
}

function latestDailyForDay(rows: TelemetryRow[], dayKey: string): TelemetryRow | null {
  let hit: TelemetryRow | null = null;
  for (const r of rows) {
    if (r.event !== "daily") {
      continue;
    }
    if (utcDayKey(r.at as string) !== dayKey) {
      continue;
    }
    hit = r;
  }
  if (hit) {
    return hit;
  }
  return syntheticDailyFromBillableTurns(rows, dayKey);
}

function syntheticDailyFromBillableTurns(
  rows: TelemetryRow[],
  dayKey: string
): TelemetryRow | null {
  let cost_usd = 0;
  let total_tokens = 0;
  let output_tokens = 0;
  let n = 0;
  for (const r of rows) {
    if (!isBillableTurnEvent(r.event)) {
      continue;
    }
    if (utcDayKey(r.at as string) !== dayKey) {
      continue;
    }
    n += 1;
    cost_usd += Number(r.cost_usd || 0);
    total_tokens += Number(r.total_tokens || 0);
    output_tokens += Number(r.output_tokens || 0);
  }
  if (n === 0) {
    return null;
  }
  return {
    at: `${dayKey}T23:59:59.000Z`,
    event: "daily",
    cost_usd,
    total_tokens,
    output_tokens,
    cumulative_cost_usd: cost_usd,
    cumulative_total_tokens: total_tokens,
    cumulative_output_tokens: output_tokens,
  };
}

function buildUsagePayload(
  rawRows: TelemetryRow[],
  csvPath: string,
  statePath: string,
  cloudSync: CloudSyncStatus | null,
  dataSource: "sqlite" | "csv"
): UsagePayload {
  const { titlesPath, sqlitePath } = defaultPaths();
  const titles = loadConversationTitles(titlesPath);
  const state = normalizeState(loadState(statePath));
  const conv =
    typeof state.conversation_id === "string" ? state.conversation_id : null;
  const { priceMode, rates } = priceRates();
  const today = new Date().toISOString().slice(0, 10);
  const { rows, costMismatchCount } = enrichRows(
    rawRows,
    titles,
    priceMode,
    rates
  );

  return {
    generatedAt: new Date().toISOString(),
    csvPath,
    sqlitePath,
    dataSource,
    hooksInstalled: hooksInstalledFlag(),
    priceMode,
    rates,
    state,
    conversationTitles: titles,
    lastTurn: lastBillableTurn(rows, conv),
    rows,
    dayTotals: totalsForUtcDay(rows, today),
    dailySnapshot: latestDailyForDay(rows, today),
    costMismatchCount,
    costInsights: buildUsageCostInsights(rows),
    cloudSync,
  };
}

export function loadUsagePayload(
  csvPath: string,
  statePath: string,
  cloudSync: CloudSyncStatus | null = null
): UsagePayload {
  const sqlitePath = defaultSqlitePath();
  const dataSource: UsagePayload["dataSource"] =
    fs.existsSync(sqlitePath) && telemetryExtensionPath ? "sqlite" : "csv";
  return buildUsagePayload(
    loadRows(csvPath),
    csvPath,
    statePath,
    cloudSync,
    dataSource
  );
}

export async function loadUsagePayloadAsync(
  csvPath: string,
  statePath: string,
  cloudSync: CloudSyncStatus | null = null
): Promise<UsagePayload> {
  const sqlitePath = defaultSqlitePath();
  const dataSource: UsagePayload["dataSource"] =
    fs.existsSync(sqlitePath) && telemetryExtensionPath ? "sqlite" : "csv";
  const rawRows = await loadRowsAsync(csvPath);
  return buildUsagePayload(
    rawRows,
    csvPath,
    statePath,
    cloudSync,
    dataSource
  );
}

export function fmtCents(usd: number | null | undefined): string {
  const v = Number(usd);
  if (!Number.isFinite(v)) {
    return "—";
  }
  return String(Math.round(v * 100)) + "¢";
}

export function fmtUsdRounded(usd: number | null | undefined): string {
  const v = Number(usd);
  if (!Number.isFinite(v)) {
    return "—";
  }
  return "$" + Math.round(v);
}

export function fmtUsdShort(usd: number | null | undefined): string {
  const v = Number(usd);
  if (!Number.isFinite(v)) {
    return "—";
  }
  if (v >= 100) {
    return "$" + Math.round(v);
  }
  return "$" + v.toFixed(2);
}

export function fmtTokens(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) {
    return "—";
  }
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    if (m >= 10) {
      return Math.round(m) + "M";
    }
    return m.toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (v >= 1000) {
    return Math.round(v / 1000) + "K";
  }
  return String(Math.round(v));
}

export function usageStatusBarText(payload: UsagePayload): string {
  const last = payload.lastTurn;
  if (!last) {
    return "$(pulse) Usage —";
  }
  const costStr = fmtCents(last.cost_usd as number);
  const tok = fmtTokens(last.total_tokens as number);
  const ctx = last.context_usage_percent;
  const ctxStr =
    ctx != null && Number(ctx) > 0
      ? " · " + Number(ctx).toFixed(0) + "% ctx"
      : "";
  return "$(pulse) Usage " + costStr + " · " + tok + ctxStr;
}
