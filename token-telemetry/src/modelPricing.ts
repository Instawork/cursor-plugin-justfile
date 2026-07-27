import * as fs from "fs";
import * as path from "path";

export type ChannelRates = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

export type ModelRateRule = {
  id?: string;
  any?: string[];
  all?: string[];
  usdPerM?: number;
  channels?: Partial<ChannelRates>;
};

export type ModelRatesConfig = {
  version: number;
  defaultUsdPerM?: number;
  defaultChannels?: Partial<ChannelRates>;
  rules: ModelRateRule[];
  source?: string;
  sourceFetched?: string;
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

/** Clear cached rates (tests). */
export function clearModelRatesCache(): void {
  cachedConfig = null;
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

const FALLBACK_CHANNELS: ChannelRates = {
  input: 1.25,
  cacheWrite: 1.25,
  cacheRead: 0.25,
  output: 6.0,
};

function channelsFromPartial(
  raw: Partial<ChannelRates> | undefined,
  fallback: ChannelRates
): ChannelRates {
  const input = Number(raw?.input ?? fallback.input);
  const cacheRead = Number(raw?.cacheRead ?? fallback.cacheRead);
  const output = Number(raw?.output ?? fallback.output);
  const cacheWrite = Number(raw?.cacheWrite ?? input);
  return { input, cacheWrite, cacheRead, output };
}

export function defaultChannelRates(): ChannelRates {
  const cfg = loadModelRatesConfig();
  if (cfg.defaultChannels) {
    return channelsFromPartial(cfg.defaultChannels, FALLBACK_CHANNELS);
  }
  if (typeof cfg.defaultUsdPerM === "number") {
    const b = cfg.defaultUsdPerM;
    return { input: b, cacheWrite: b, cacheRead: b, output: b };
  }
  return { ...FALLBACK_CHANNELS };
}

export function modelChannelRates(model: string | null | undefined): ChannelRates {
  const override = process.env.TOKEN_HOOK_MODEL_RATE_OVERRIDE?.trim();
  if (override) {
    const v = parseFloat(override);
    if (Number.isFinite(v)) {
      return { input: v, cacheWrite: v, cacheRead: v, output: v };
    }
  }
  const cfg = loadModelRatesConfig();
  const fallback = defaultChannelRates();
  const modelLower = String(model ?? "").trim().toLowerCase();
  for (const rule of cfg.rules) {
    if (!ruleMatches(modelLower, rule)) {
      continue;
    }
    if (rule.channels) {
      return channelsFromPartial(rule.channels, fallback);
    }
    if (typeof rule.usdPerM === "number") {
      const b = rule.usdPerM;
      return { input: b, cacheWrite: b, cacheRead: b, output: b };
    }
  }
  return fallback;
}

export function modelEffectiveUsdPerM(model: string | null | undefined): number {
  return modelChannelRates(model).input;
}

export function costFromChannels(
  uncached: number,
  out: number,
  cacheR: number,
  cacheW: number,
  channels: ChannelRates
): number {
  return (
    (uncached * channels.input +
      out * channels.output +
      cacheR * channels.cacheRead +
      cacheW * channels.cacheWrite) /
    1_000_000
  );
}
