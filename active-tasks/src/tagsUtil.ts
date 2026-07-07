const MAX_TAG_LEN = 64;

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
