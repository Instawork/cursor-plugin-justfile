export const STATUS_KEYS = [
  "blocked",
  "review",
  "progress",
  "prioritized",
  "backlog",
] as const;

export type StatusKey = (typeof STATUS_KEYS)[number];

const STATUS_KEY_SET = new Set<string>(STATUS_KEYS);

/** Old keys rewritten to backlog on read and on schema migrate. */
const LEGACY_STATUS_KEY_MAP: Record<string, StatusKey> = {
  ready: "backlog",
  paused: "backlog",
  other: "backlog",
};

export function isStatusKey(raw: string): raw is StatusKey {
  return STATUS_KEY_SET.has(raw);
}

export function normalizeStatusKey(raw: unknown): StatusKey {
  if (typeof raw !== "string") {
    return "backlog";
  }
  const k = raw.trim().toLowerCase();
  if (isStatusKey(k)) {
    return k;
  }
  if (LEGACY_STATUS_KEY_MAP[k]) {
    return LEGACY_STATUS_KEY_MAP[k];
  }
  return "backlog";
}

/** Infer bucket from free-text status (panel + backfill). */
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
  if (/priorit/.test(s)) {
    return "prioritized";
  }
  if (/backlog|ready|green|merge|ci green|pushed|pause/.test(s)) {
    return "backlog";
  }
  return "backlog";
}

export function statusKeyLabel(key: StatusKey): string {
  switch (key) {
    case "blocked":
      return "Blocked";
    case "review":
      return "In Review";
    case "progress":
      return "In Progress";
    case "prioritized":
      return "Prioritized";
    default:
      return "Backlog";
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
  // Priority is 0 = highest, matching the roster and the Python CLI.
  const p = clampPriority(input.priority ?? 1);
  if (p <= 0) {
    return "high";
  }
  const key =
    input.status_key && isStatusKey(input.status_key)
      ? input.status_key
      : inferStatusKeyFromLabel(input.status);
  if (key === "blocked") {
    return "high";
  }
  if (key === "review" || key === "progress" || key === "prioritized") {
    return p <= 1 ? "high" : "medium";
  }
  if (key === "backlog") {
    return "low";
  }
  return p <= 1 ? "medium" : "muted";
}
