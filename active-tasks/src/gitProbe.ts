import { spawn } from "child_process";
import * as fs from "fs";
import { resolveWorktreePath } from "./paths";

export const DEFAULT_GIT_TIMEOUT_MS = 8_000;

export type GitProbe = {
  /** Resolved absolute path that was probed. */
  path: string;
  exists: boolean;
  branch: string | null;
  detached: boolean;
  dirtyCount: number;
  ahead: number;
  behind: number;
  lastCommitIso: string | null;
  error: string | null;
};

export type WorktreeEntry = {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  bare: boolean;
  /** The repo's main working copy, as opposed to a linked worktree. */
  primary: boolean;
};

function gitTimeoutMs(): number {
  const raw = process.env.ACTIVE_TASKS_GIT_TIMEOUT_MS;
  if (!raw?.trim()) {
    return DEFAULT_GIT_TIMEOUT_MS;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GIT_TIMEOUT_MS;
}

/** Run `git` in `cwd` with stdout capture and a hard timeout. */
export function runGit(
  args: string[],
  cwd: string,
  timeoutMs = gitTimeoutMs()
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("git timed out"));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `git exited ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export type PorcelainStatus = {
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  dirtyCount: number;
};

/**
 * Parse `git status --porcelain=v1 --branch`.
 *
 * One call gives branch, upstream divergence, and dirtiness, which is why this
 * is the only status command the probe runs.
 */
export function parsePorcelainStatus(stdout: string): PorcelainStatus {
  const result: PorcelainStatus = {
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
  };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    if (!line.startsWith("## ")) {
      result.dirtyCount += 1;
      continue;
    }
    const header = line.slice(3);
    if (header.startsWith("HEAD (no branch)")) {
      result.detached = true;
    } else {
      const name = header.split("...")[0]!.trim();
      result.branch = name.split(" ")[0] || null;
    }
    const ahead = /\bahead (\d+)/.exec(header);
    if (ahead) {
      result.ahead = Number(ahead[1]);
    }
    const behind = /\bbehind (\d+)/.exec(header);
    if (behind) {
      result.behind = Number(behind[1]);
    }
  }
  return result;
}

/** Parse `git worktree list --porcelain`. First entry is the primary clone. */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  const push = (): void => {
    if (current) {
      entries.push(current);
      current = null;
    }
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) {
      push();
      continue;
    }
    if (line.startsWith("worktree ")) {
      push();
      current = {
        path: resolveWorktreePath(line.slice("worktree ".length)),
        branch: null,
        head: null,
        detached: false,
        bare: false,
        primary: entries.length === 0,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim() || null;
    } else if (line.startsWith("branch ")) {
      current.branch =
        line.slice("branch ".length).trim().replace(/^refs\/heads\//, "") ||
        null;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  push();
  return entries;
}

const MISSING_PROBE = (resolved: string): GitProbe => ({
  path: resolved,
  exists: false,
  branch: null,
  detached: false,
  dirtyCount: 0,
  ahead: 0,
  behind: 0,
  lastCommitIso: null,
  error: null,
});

/** Branch, dirtiness, divergence, and last-commit time for one worktree. */
export async function probeWorktree(rawPath: string): Promise<GitProbe> {
  const resolved = resolveWorktreePath(rawPath);
  if (!resolved || !fs.existsSync(resolved)) {
    return MISSING_PROBE(resolved);
  }
  const probe: GitProbe = { ...MISSING_PROBE(resolved), exists: true };
  try {
    await runGit(["rev-parse", "--is-inside-work-tree"], resolved);
  } catch (err) {
    probe.error = err instanceof Error ? err.message : String(err);
    return probe;
  }
  try {
    const status = parsePorcelainStatus(
      await runGit(["status", "--porcelain=v1", "--branch"], resolved)
    );
    probe.branch = status.branch;
    probe.detached = status.detached;
    probe.ahead = status.ahead;
    probe.behind = status.behind;
    probe.dirtyCount = status.dirtyCount;
  } catch (err) {
    probe.error = err instanceof Error ? err.message : String(err);
  }
  try {
    const out = await runGit(["log", "-1", "--format=%cI"], resolved);
    probe.lastCommitIso = out.trim() || null;
  } catch {
    /* a worktree with no commits is not an error worth surfacing */
  }
  return probe;
}

/** Every worktree git knows about for the repo containing `repoRoot`. */
export async function listWorktrees(
  repoRoot: string
): Promise<WorktreeEntry[]> {
  const resolved = resolveWorktreePath(repoRoot);
  if (!resolved || !fs.existsSync(resolved)) {
    return [];
  }
  try {
    return parseWorktreeList(
      await runGit(["worktree", "list", "--porcelain"], resolved)
    );
  } catch {
    return [];
  }
}
