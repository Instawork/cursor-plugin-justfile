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

export function reconcileItemCount(discovery: TaskDiscoverySnapshot): number {
  return (
    discovery.missingPrs.length +
    discovery.untrackedCloudAgents.length +
    discovery.staleTrackedPrs.length +
    (discovery.structuralMergeCandidates?.length ?? 0)
  );
}

/** Keep prior +N on the status bar while a discovery scan is in flight and cache is empty. */
export function reconcileExtraWithScanHold(
  discovery: TaskDiscoverySnapshot,
  scanPending: boolean,
  previousDiscovery: TaskDiscoverySnapshot | undefined
): number {
  const cur = reconcileItemCount(discovery);
  if (cur > 0 || discovery.scannedAt) {
    return cur;
  }
  if (scanPending && previousDiscovery) {
    const prev = reconcileItemCount(previousDiscovery);
    if (prev > 0) {
      return prev;
    }
  }
  return 0;
}

export function activeTasksStatusBarText(
  payload: ActiveTasksPayload,
  options?: { reconcileExtra?: number }
): string {
  if (payload.loadError || payload.notice?.level === "error") {
    return "$(error) Tasks error";
  }
  const todos = payload.activeTasks.todos || [];
  const reconcileExtra =
    options?.reconcileExtra ?? reconcileItemCount(payload.discovery);
  if (!todos.length) {
    if (reconcileExtra) {
      return "$(checklist) Tasks +" + reconcileExtra;
    }
    return "$(checklist) Tasks —";
  }
  const open = todos.filter((t) => !t.done).length;
  if (reconcileExtra > 0) {
    return "$(checklist) Tasks " + open + " +" + reconcileExtra;
  }
  return "$(checklist) Tasks " + open + " open";
}
