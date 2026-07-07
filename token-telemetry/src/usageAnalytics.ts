import { isBillableTurnEvent } from "./billableEvents";
import { modelEffectiveUsdPerM } from "./modelPricing";
import type { TelemetryRow } from "./telemetry";

export type ModelCostBucket = {
  modelKey: string;
  label: string;
  turns: number;
  costUsd: number;
  totalTokens: number;
  avgCostUsd: number;
  usdPerMTokens: number;
  shareOfCost: number;
};

export type CostWindowTotals = {
  turns: number;
  costUsd: number;
  totalTokens: number;
  avgCostUsd: number;
  usdPerMTokens: number;
};

export type AutoSavingsEstimate = {
  autoTurns: number;
  autoTokens: number;
  actualCostUsd: number;
  atOpusRateUsd: number;
  atSonnetRateUsd: number;
  savedVsOpusUsd: number;
  savedVsSonnetUsd: number;
  pctSavedVsOpus: number;
};

export type UsageCostInsights = {
  today: CostWindowTotals;
  last7d: CostWindowTotals;
  todayByModel: ModelCostBucket[];
  last7dByModel: ModelCostBucket[];
  autoToday: AutoSavingsEstimate | null;
  autoLast7d: AutoSavingsEstimate | null;
  referenceUsdPerM: {
    auto: number;
    opus: number;
    sonnet: number;
  };
};

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

function rowTokens(row: TelemetryRow): number {
  const t = Number(row.total_tokens || 0);
  if (t > 0) {
    return t;
  }
  return (
    Number(row.input_uncached_tokens || 0) +
    Number(row.cache_read_tokens || 0) +
    Number(row.cache_write_tokens || 0) +
    Number(row.output_tokens || 0)
  );
}

export function isAutoModel(model: unknown): boolean {
  const m = String(model ?? "")
    .trim()
    .toLowerCase();
  if (!m || m === "default") {
    return true;
  }
  return m.includes("auto") && !m.includes("opus");
}

export function modelBucketKey(model: unknown): string {
  const raw = String(model ?? "").trim();
  if (!raw || raw.toLowerCase() === "default") {
    return "auto";
  }
  return raw.toLowerCase();
}

export function modelDisplayLabel(modelKey: string): string {
  if (modelKey === "auto") {
    return "Auto";
  }
  let s = modelKey;
  s = s.replace(/-thinking(-high|-medium)?$/i, "");
  s = s.replace(/^claude-/, "");
  s = s.replace(/-/g, " ");
  if (s.length > 28) {
    return s.slice(0, 25) + "…";
  }
  return s;
}

function hypotheticalFlatCostUsd(row: TelemetryRow, usdPerM: number): number {
  return (rowTokens(row) * usdPerM) / 1_000_000;
}

function aggregateTurns(turns: TelemetryRow[]): {
  totals: CostWindowTotals;
  buckets: ModelCostBucket[];
} {
  const byKey = new Map<
    string,
    { label: string; turns: number; costUsd: number; totalTokens: number }
  >();
  let costUsd = 0;
  let totalTokens = 0;
  for (const row of turns) {
    const key = modelBucketKey(row.model);
    const label = key === "auto" ? "Auto" : modelDisplayLabel(key);
    const c = Number(row.cost_usd || 0);
    const tok = rowTokens(row);
    costUsd += c;
    totalTokens += tok;
    const hit = byKey.get(key) ?? { label, turns: 0, costUsd: 0, totalTokens: 0 };
    hit.turns += 1;
    hit.costUsd += c;
    hit.totalTokens += tok;
    byKey.set(key, hit);
  }
  const turnsN = turns.length;
  const totals: CostWindowTotals = {
    turns: turnsN,
    costUsd,
    totalTokens,
    avgCostUsd: turnsN ? costUsd / turnsN : 0,
    usdPerMTokens: totalTokens ? (costUsd / totalTokens) * 1_000_000 : 0,
  };
  const buckets: ModelCostBucket[] = [...byKey.entries()]
    .map(([modelKey, v]) => ({
      modelKey,
      label: v.label,
      turns: v.turns,
      costUsd: v.costUsd,
      totalTokens: v.totalTokens,
      avgCostUsd: v.turns ? v.costUsd / v.turns : 0,
      usdPerMTokens: v.totalTokens ? (v.costUsd / v.totalTokens) * 1_000_000 : 0,
      shareOfCost: costUsd > 0 ? v.costUsd / costUsd : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
  return { totals, buckets };
}

function autoSavings(
  turns: TelemetryRow[],
  opusPerM: number,
  sonnetPerM: number
): AutoSavingsEstimate | null {
  const autoTurns = turns.filter((r) => isAutoModel(r.model));
  if (!autoTurns.length) {
    return null;
  }
  let actualCostUsd = 0;
  let autoTokens = 0;
  let atOpusRateUsd = 0;
  let atSonnetRateUsd = 0;
  for (const row of autoTurns) {
    actualCostUsd += Number(row.cost_usd || 0);
    autoTokens += rowTokens(row);
    atOpusRateUsd += hypotheticalFlatCostUsd(row, opusPerM);
    atSonnetRateUsd += hypotheticalFlatCostUsd(row, sonnetPerM);
  }
  const savedVsOpusUsd = Math.max(0, atOpusRateUsd - actualCostUsd);
  const savedVsSonnetUsd = Math.max(0, atSonnetRateUsd - actualCostUsd);
  const pctSavedVsOpus =
    atOpusRateUsd > 0 ? (savedVsOpusUsd / atOpusRateUsd) * 100 : 0;
  return {
    autoTurns: autoTurns.length,
    autoTokens,
    actualCostUsd,
    atOpusRateUsd,
    atSonnetRateUsd,
    savedVsOpusUsd,
    savedVsSonnetUsd,
    pctSavedVsOpus,
  };
}

function billableTurnsOnDay(rows: TelemetryRow[], dayKey: string): TelemetryRow[] {
  return rows.filter(
    (r) => isBillableTurnEvent(r.event) && utcDayKey(r.at as string) === dayKey
  );
}

function billableTurnsLastNDays(rows: TelemetryRow[], days: number): TelemetryRow[] {
  const end = new Date();
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  start.setUTCHours(0, 0, 0, 0);
  return rows.filter((r) => {
    if (!isBillableTurnEvent(r.event)) {
      return false;
    }
    const d = new Date(String(r.at));
    return !Number.isNaN(d.getTime()) && d >= start && d <= end;
  });
}

export function buildUsageCostInsights(rows: TelemetryRow[]): UsageCostInsights {
  const today = new Date().toISOString().slice(0, 10);
  const todayTurns = billableTurnsOnDay(rows, today);
  const last7Turns = billableTurnsLastNDays(rows, 7);
  const autoRate = modelEffectiveUsdPerM("default");
  const opusRate = modelEffectiveUsdPerM("claude-opus-4-6-opus-high-thinking");
  const sonnetRate = modelEffectiveUsdPerM("claude-4-5-sonnet-medium-thinking");
  const todayAgg = aggregateTurns(todayTurns);
  const last7Agg = aggregateTurns(last7Turns);
  return {
    today: todayAgg.totals,
    last7d: last7Agg.totals,
    todayByModel: todayAgg.buckets,
    last7dByModel: last7Agg.buckets,
    autoToday: autoSavings(todayTurns, opusRate, sonnetRate),
    autoLast7d: autoSavings(last7Turns, opusRate, sonnetRate),
    referenceUsdPerM: {
      auto: autoRate,
      opus: opusRate,
      sonnet: sonnetRate,
    },
  };
}
