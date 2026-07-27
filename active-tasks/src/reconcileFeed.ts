import { getMeta, setMeta } from "./activeTasksStore";
import {
  filterMissingPrsForFeed,
  filterUntrackedCloudForFeed,
} from "./reconcileFeedFilter";

export {
  filterMissingPrsForFeed,
  filterUntrackedCloudForFeed,
  prActivityMs,
} from "./reconcileFeedFilter";

const META_WATERMARK_MS = "reconcile_feed_watermark_ms";

type ConfigSection = {
  get<T>(key: string, defaultValue?: T): T;
};

function activeTasksConfig(): ConfigSection | null {
  try {
    // Lazy load so Node integration tests can import discovery/payload without vscode.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require("vscode") as typeof import("vscode");
    return vscode.workspace.getConfiguration("activeTasks");
  } catch {
    return null;
  }
}

/** Full history vs only PRs/agents touched after the feed baseline. */
export function reconcileBackfillEnabled(): boolean {
  const env = process.env.ACTIVE_TASKS_RECONCILE_BACKFILL?.trim().toLowerCase();
  if (env === "1" || env === "true" || env === "yes") {
    return true;
  }
  if (env === "0" || env === "false" || env === "no") {
    return false;
  }
  const cfg = activeTasksConfig();
  return cfg?.get<boolean>("reconcile.backfill", false) ?? false;
}

export function includeReviewRequestedPrs(): boolean {
  const cfg = activeTasksConfig();
  return cfg?.get<boolean>("reconcile.includeReviewRequested", true) ?? true;
}

/**
 * When backfill is off, ensure a baseline exists (first run = now, no historical missing).
 */
export function reconcileFeedWatermarkMs(): number | null {
  if (reconcileBackfillEnabled()) {
    return null;
  }
  const existing = getMeta(META_WATERMARK_MS);
  if (existing?.trim()) {
    const n = Number(existing);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  const now = Date.now();
  setMeta(META_WATERMARK_MS, String(now));
  return now;
}

export function resetReconcileFeedBaseline(): number {
  const now = Date.now();
  setMeta(META_WATERMARK_MS, String(now));
  return now;
}

export function reconcileFeedSummary(): {
  backfill: boolean;
  watermarkMs: number | null;
  includeReviewRequested: boolean;
} {
  const backfill = reconcileBackfillEnabled();
  return {
    backfill,
    watermarkMs: backfill ? null : reconcileFeedWatermarkMs(),
    includeReviewRequested: includeReviewRequestedPrs(),
  };
}
