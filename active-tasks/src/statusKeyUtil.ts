export const STATUS_KEYS = [
  "blocked",
  "review",
  "progress",
  "ready",
  "paused",
  "other",
] as const;

export type StatusKey = (typeof STATUS_KEYS)[number];

const STATUS_KEY_SET = new Set<string>(STATUS_KEYS);

export function isStatusKey(raw: string): raw is StatusKey {
  return STATUS_KEY_SET.has(raw);
}

export function normalizeStatusKey(raw: unknown): StatusKey {
  if (typeof raw === "string" && isStatusKey(raw.trim().toLowerCase())) {
    return raw.trim().toLowerCase() as StatusKey;
  }
  return "other";
}

/** Infer bucket from legacy free-text status (panel + backfill). */
export function inferStatusKeyFromLabel(status: string | null | undefined): StatusKey {
  const s = String(status || "").toLowerCase();
  if (/block|fail|red|tach/.test(s)) {
    return "blocked";
  }
  if (/review|duncan|waiting/.test(s)) {
    return "review";
  }
  if (/progress|step|walkthrough|active branch/.test(s)) {
    return "progress";
  }
  if (/ready|green|merge|ci green|pushed/.test(s)) {
    return "ready";
  }
  if (/pause|paused/.test(s)) {
    return "paused";
  }
  return "other";
}

export function statusKeyLabel(key: StatusKey): string {
  switch (key) {
    case "blocked":
      return "Blocked";
    case "review":
      return "In review";
    case "progress":
      return "In progress";
    case "ready":
      return "Ready";
    case "paused":
      return "Paused";
    default:
      return "Other";
  }
}

export function clampPriority(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 1;
  }
  const n = Math.round(raw);
  if (n < 0) {
    return 0;
  }
  if (n > 3) {
    return 3;
  }
  return n;
}

export function urgencyFromTodo(input: {
  done?: boolean;
  status_key?: StatusKey | null;
  status?: string | null;
  priority?: number | null;
}): "high" | "medium" | "low" | "muted" {
  if (input.done) {
    return "muted";
  }
  const p = clampPriority(input.priority ?? 1);
  if (p >= 3) {
    return "high";
  }
  const key =
    input.status_key && isStatusKey(input.status_key)
      ? input.status_key
      : inferStatusKeyFromLabel(input.status);
  if (key === "blocked") {
    return "high";
  }
  if (key === "review" || key === "progress") {
    return p >= 2 ? "high" : "medium";
  }
  if (key === "ready") {
    return "low";
  }
  return p >= 2 ? "medium" : "muted";
}
