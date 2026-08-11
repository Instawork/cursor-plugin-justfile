import * as os from "os";
import * as path from "path";
import type { TaskLink } from "./taskModel";

/** Where living-spec planning docs live. */
export function plansRoot(): string {
  return path.join(os.homedir(), ".cursor", "plans");
}

/**
 * The plan file a link points at, or null.
 *
 * Deliberately strict: the panel turns this into an "open file" action, so it
 * only accepts `*.plan.md` inside the plans directory. Anything else stays a
 * plain link.
 */
export function planPathFromLink(link: TaskLink): string | null {
  return planPathFromUrl(link.url);
}

export function planPathFromUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return null;
  }
  let candidate = trimmed;
  if (candidate.startsWith("file://")) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    return null;
  }
  if (candidate.startsWith("~/")) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }
  const resolved = path.normalize(path.resolve(candidate));
  const root = plansRoot();
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved.endsWith(".plan.md") ? resolved : null;
}

/** The first plan link on a row, if any. */
export function planLinkFor(links: TaskLink[] | undefined): string | null {
  for (const link of links ?? []) {
    const plan = planPathFromLink(link);
    if (plan) {
      return plan;
    }
  }
  return null;
}
