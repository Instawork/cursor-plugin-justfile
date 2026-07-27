const MAX_TAG_LEN = 64;

/** Stable accent colors for tag chips (panel uses the same palette in JS). */
const TAG_PALETTE = [
  "#2563eb",
  "#0d9488",
  "#7c3aed",
  "#c026d3",
  "#ea580c",
  "#ca8a04",
  "#059669",
  "#dc2626",
  "#0891b2",
  "#4f46e5",
] as const;

const TAG_ACCENT_OVERRIDES: Record<string, string> = {
  cursor: "#6366f1",
  datadog: "#632CA6",
  deploy: "#ea580c",
  finch: "#0d9488",
  infrastructure: "#7c3aed",
  instawork: "#2563eb",
  release: "#ca8a04",
  sentry: "#6C5FC7",
  sre: "#774AA4",
};

function hashTagKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function tagAccentFor(tag: string): string {
  const key = tag.trim().toLowerCase();
  if (!key) {
    return TAG_PALETTE[0];
  }
  const override = TAG_ACCENT_OVERRIDES[key];
  if (override) {
    return override;
  }
  return TAG_PALETTE[hashTagKey(key) % TAG_PALETTE.length];
}

export function normalizeTag(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t || t.length > MAX_TAG_LEN) {
    return null;
  }
  return t;
}

export function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const t = normalizeTag(item);
    if (!t) {
      continue;
    }
    const key = t.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function parseTagsJson(raw: string | null | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    return sanitizeTags(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}
