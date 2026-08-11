import * as os from "os";
import * as path from "path";

/**
 * Single home-expansion + normalization for worktree paths.
 *
 * This logic was written three times with three slightly different behaviors
 * (one of them a substring test), which meant `~/code/foo` and
 * `$HOME/code/foo` compared as different worktrees. Everything that
 * touches a user-entered path goes through here.
 */
export function resolveWorktreePath(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return "";
  }
  const expanded =
    trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
  return path.normalize(path.resolve(expanded));
}

/** True when two paths point at the same worktree, `~` or not. */
export function sameWorktree(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const left = resolveWorktreePath(a);
  const right = resolveWorktreePath(b);
  return left !== "" && left === right;
}

/** True when `child` is `parent` or sits inside it. */
export function isInsideWorktree(
  child: string | null | undefined,
  parent: string | null | undefined
): boolean {
  const c = resolveWorktreePath(child);
  const p = resolveWorktreePath(parent);
  if (!c || !p) {
    return false;
  }
  return c === p || c.startsWith(p + path.sep);
}
