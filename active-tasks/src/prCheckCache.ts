import type { PrCheckSummary } from "./githubPrStatus";
import { getMeta, setMeta } from "./activeTasksStore";

const CACHE_META = "pr_check_cache_json";
const CACHE_TTL_MS = 8 * 60 * 1000;

type CacheEntry = PrCheckSummary;

type CacheBlob = Record<string, CacheEntry>;

function readBlob(): CacheBlob {
  const raw = getMeta(CACHE_META);
  if (!raw?.trim()) {
    return {};
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as CacheBlob) : {};
  } catch {
    return {};
  }
}

function writeBlob(blob: CacheBlob): void {
  setMeta(CACHE_META, JSON.stringify(blob));
}

export function getCachedPrStatus(prUrl: string): PrCheckSummary | null {
  const key = prUrl.trim();
  if (!key) {
    return null;
  }
  const entry = readBlob()[key];
  if (!entry?.fetchedAt) {
    return null;
  }
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  if (Number.isNaN(age) || age > CACHE_TTL_MS) {
    return null;
  }
  return entry;
}

export function setCachedPrStatus(prUrl: string, summary: PrCheckSummary): void {
  const key = prUrl.trim();
  if (!key) {
    return;
  }
  const blob = readBlob();
  blob[key] = summary;
  writeBlob(blob);
}

export function cachedPrStatusByTodoId(
  todos: { id: string; pr_url?: string; prs?: { url: string }[] }[]
): Record<string, PrCheckSummary> {
  const out: Record<string, PrCheckSummary> = {};
  for (const todo of todos) {
    const url =
      todo.pr_url?.trim() ||
      todo.prs?.find((p) => p.url?.trim())?.url?.trim();
    if (!url) {
      continue;
    }
    const hit = getCachedPrStatus(url);
    if (hit) {
      out[todo.id] = hit;
    }
  }
  return out;
}
