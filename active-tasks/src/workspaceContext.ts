import { spawnSync } from "child_process";
import * as os from "os";
import * as path from "path";
import { repoKeyFromNameWithOwner } from "./repoSlugs";

export type WorkspaceMatch = {
  repoKey: string | null;
  branch: string | null;
  folder: string | null;
};

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) {
    return null;
  }
  return r.stdout.trim() || null;
}

export function detectWorkspaceMatch(
  workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined
): WorkspaceMatch {
  if (!workspaceFolders?.length) {
    return { repoKey: null, branch: null, folder: null };
  }
  const folder = workspaceFolders[0].uri.fsPath;
  const remote = git(folder, ["remote", "get-url", "origin"]);
  let repoKey: string | null = null;
  if (remote) {
    const m = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) {
      repoKey = repoKeyFromNameWithOwner(m[1]);
    }
  }
  const branch = git(folder, ["branch", "--show-current"]);
  return { repoKey, branch, folder: path.normalize(folder) };
}

export function todoMatchesWorkspace(
  todo: {
    repo?: string | null;
    branch?: string;
    worktree?: string;
  },
  ctx: WorkspaceMatch
): boolean {
  if (ctx.folder && todo.worktree) {
    const wt = path.normalize(
      todo.worktree.startsWith("~")
        ? todo.worktree.replace(/^~/, os.homedir())
        : path.resolve(todo.worktree)
    );
    if (ctx.folder === wt || ctx.folder.startsWith(wt + path.sep)) {
      return true;
    }
  }
  if (ctx.repoKey && todo.repo === ctx.repoKey) {
    if (!ctx.branch || !todo.branch) {
      return true;
    }
    return todo.branch === ctx.branch;
  }
  return false;
}
