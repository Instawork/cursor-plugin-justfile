import type { ParsedSessionTodo as SessionTodo } from "./taskModel";
import {
  enrichTodosWithPrStatus,
  type PrCheckSummary,
} from "./githubPrStatus";
import {
  detectWorkspaceMatch,
  todoMatchesWorkspace,
  type WorkspaceMatch,
} from "./workspaceContext";
import type { GitProbe } from "./gitProbe";
import { scanWorktrees } from "./worktreeDiscovery";
import * as vscode from "vscode";

export type TaskDiscoverySnapshot = {
  scannedAt: string | null;
  githubError: string | null;
  cloudError: string | null;
  prStatusByTodoId: Record<string, PrCheckSummary>;
  gitStatusByTodoId: Record<string, GitProbe>;
  workspace: WorkspaceMatch;
};

let cached: TaskDiscoverySnapshot | null = null;
let cachedAt = 0;
let inflight: Promise<TaskDiscoverySnapshot> | null = null;

const CACHE_MS = 3 * 60 * 1000;

function emptyDiscovery(workspace: WorkspaceMatch): TaskDiscoverySnapshot {
  return {
    scannedAt: null,
    githubError: null,
    cloudError: null,
    prStatusByTodoId: {},
    gitStatusByTodoId: {},
    workspace,
  };
}

async function scanDiscovery(
  _secrets: vscode.SecretStorage,
  todos: SessionTodo[],
  workspace: WorkspaceMatch
): Promise<TaskDiscoverySnapshot> {
  const open = todos.filter((t) => !t.done);
  const [prStatusByTodoId, worktrees] = await Promise.all([
    enrichTodosWithPrStatus(open),
    scanWorktrees(todos),
  ]);

  return {
    scannedAt: new Date().toISOString(),
    githubError: null,
    cloudError: null,
    prStatusByTodoId,
    gitStatusByTodoId: worktrees.gitStatusByTodoId,
    workspace,
  };
}

export async function loadTaskDiscovery(
  secrets: vscode.SecretStorage,
  todos: SessionTodo[],
  workspace: WorkspaceMatch,
  options?: { force?: boolean }
): Promise<TaskDiscoverySnapshot> {
  const now = Date.now();
  if (!options?.force && cached && now - cachedAt < CACHE_MS) {
    return { ...cached, workspace };
  }
  if (inflight) {
    if (options?.force) {
      await inflight.catch(() => undefined);
    } else {
      return inflight;
    }
  }

  inflight = scanDiscovery(secrets, todos, workspace)
    .then((result) => {
      cached = result;
      cachedAt = Date.now();
      return result;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function peekTaskDiscovery(
  workspace: WorkspaceMatch
): TaskDiscoverySnapshot {
  if (!cached) {
    return emptyDiscovery(workspace);
  }
  return { ...cached, workspace };
}

export function invalidateTaskDiscoveryCache(): void {
  cached = null;
  cachedAt = 0;
}

export { todoMatchesWorkspace };
