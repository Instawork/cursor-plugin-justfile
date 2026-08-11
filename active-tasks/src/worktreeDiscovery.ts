import * as os from "os";
import * as path from "path";
import type { ParsedSessionTodo as SessionTodo } from "./taskModel";
import {
  listWorktrees,
  probeWorktree,
  type GitProbe,
  type WorktreeEntry,
} from "./gitProbe";
import { resolveWorktreePath } from "./paths";

const MAX_PROBES = 60;

/**
 * Repo roots to enumerate worktrees from. `git worktree list` reports every
 * worktree of a repo from any one of them, so the primary clones are enough.
 */
export function defaultRepoRoots(): string[] {
  const raw = process.env.ACTIVE_TASKS_REPO_ROOTS;
  if (raw?.trim()) {
    return raw
      .split(path.delimiter)
      .map((p) => resolveWorktreePath(p))
      .filter(Boolean);
  }
  const home = os.homedir();
  return [
    path.join(home, "code/instawork"),
    path.join(home, "code/finch"),
  ];
}

export type WorktreeScan = {
  gitStatusByTodoId: Record<string, GitProbe>;
};

/**
 * Probe worktrees referenced by open roster rows so per-row git chips populate.
 */
export async function scanWorktrees(
  todos: SessionTodo[],
  repoRoots = defaultRepoRoots()
): Promise<WorktreeScan> {
  const entries: WorktreeEntry[] = [];
  const seenEntry = new Set<string>();
  for (const root of repoRoots) {
    for (const entry of await listWorktrees(root)) {
      if (!seenEntry.has(entry.path)) {
        seenEntry.add(entry.path);
        entries.push(entry);
      }
    }
  }

  const openWithWorktree = todos.filter((t) => !t.done && t.worktree?.trim());
  const targets = new Set<string>();
  for (const todo of openWithWorktree) {
    targets.add(resolveWorktreePath(todo.worktree));
  }

  const probes = new Map<string, GitProbe>();
  const paths = [...targets].filter(Boolean).slice(0, MAX_PROBES);
  const results = await Promise.all(paths.map((p) => probeWorktree(p)));
  results.forEach((probe, i) => probes.set(paths[i]!, probe));

  const gitStatusByTodoId: Record<string, GitProbe> = {};
  for (const todo of openWithWorktree) {
    const probe = probes.get(resolveWorktreePath(todo.worktree));
    if (probe) {
      gitStatusByTodoId[todo.id] = probe;
    }
  }

  return { gitStatusByTodoId };
}
