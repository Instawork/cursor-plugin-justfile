import * as fs from "fs";
import * as path from "path";

export type ModelRateRule = {
  id?: string;
  any?: string[];
  all?: string[];
  usdPerM: number;
};

export type ModelRatesConfig = {
  version: number;
  defaultUsdPerM: number;
  rules: ModelRateRule[];
};

let cachedConfig: ModelRatesConfig | null = null;

function ratesFilePath(): string {
  return path.join(__dirname, "..", "bundled", "hooks", "cursor-model-rates.json");
}

export function loadModelRatesConfig(): ModelRatesConfig {
  if (cachedConfig) {
    return cachedConfig;
  }
  const raw = fs.readFileSync(ratesFilePath(), "utf8");
  cachedConfig = JSON.parse(raw) as ModelRatesConfig;
  return cachedConfig;
}

function ruleMatches(modelLower: string, rule: ModelRateRule): boolean {
  const anyParts = (rule.any ?? []).map((s) => s.toLowerCase());
  const allParts = (rule.all ?? []).map((s) => s.toLowerCase());
  if (allParts.length && !allParts.every((p) => modelLower.includes(p))) {
    return false;
  }
  if (anyParts.length && !anyParts.some((p) => modelLower.includes(p))) {
    return false;
  }
  if (!anyParts.length && !allParts.length) {
    return false;
  }
  return true;
}

export function normalizePriceMode(mode: string | undefined): string {
  const m = (mode || "model").trim().toLowerCase();
  if (m === "billing" || m === "by-model" || m === "by_model") {
    return "model";
  }
  if (m === "auto") {
    return "flat";
  }
  return m;
}

export function modelEffectiveUsdPerM(model: string | null | undefined): number {
  const override = process.env.TOKEN_HOOK_MODEL_RATE_OVERRIDE?.trim();
  if (override) {
    const v = parseFloat(override);
    if (Number.isFinite(v)) {
      return v;
    }
  }
  const cfg = loadModelRatesConfig();
  const modelLower = String(model ?? "").trim().toLowerCase();
  for (const rule of cfg.rules) {
    if (ruleMatches(modelLower, rule)) {
      return rule.usdPerM;
    }
  }
  return cfg.defaultUsdPerM;
}
