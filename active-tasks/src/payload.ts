import { loadActiveTasks, type ActiveTasksSnapshot } from "./activeTasks";
import { activeTasksDbPath } from "./activeTasksStore";
import type { TaskDiscoverySnapshot } from "./discovery";
import { peekTaskDiscovery } from "./discovery";
import {
  detectWorkspaceMatch,
  type WorkspaceMatch,
} from "./workspaceContext";
import type { PanelNotice } from "./panelNotice";

export type { ActiveTasksSnapshot };

export type ActiveTasksPayload = {
  generatedAt: string;
  activeTasks: ActiveTasksSnapshot;
  discovery: TaskDiscoverySnapshot;
  loadError?: string | null;
  notice?: PanelNotice | null;
};

export function loadActiveTasksPayload(
  workspace?: WorkspaceMatch
): ActiveTasksPayload {
  const ws =
    workspace ??
    detectWorkspaceMatch(undefined);
  try {
    return {
      generatedAt: new Date().toISOString(),
      activeTasks: loadActiveTasks(),
      discovery: peekTaskDiscovery(ws),
      loadError: null,
      notice: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    let source = "";
    try {
      source = activeTasksDbPath();
    } catch {
      source = "(unknown path)";
    }
    return {
      generatedAt: new Date().toISOString(),
      activeTasks: {
        updatedAt: null,
        sessionId: null,
        source,
        tasks: [],
        tagVocab: [],
        todos: [],
      },
      discovery: peekTaskDiscovery(ws),
      loadError: msg,
      notice: {
        level: "error",
        title: "Database unavailable",
        detail: msg,
        action: "retry",
      },
    };
  }
}

export function activeTasksStatusBarText(payload: ActiveTasksPayload): string {
  if (payload.loadError || payload.notice?.level === "error") {
    return "$(error) Tasks error";
  }
  const todos = payload.activeTasks.todos || [];
  if (!todos.length) {
    return "$(checklist) Tasks —";
  }
  const open = todos.filter((t) => !t.done).length;
  return "$(checklist) Tasks " + open;
}
