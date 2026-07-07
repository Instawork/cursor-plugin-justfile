import { loadActiveTasks, type ActiveTasksSnapshot } from "./activeTasks";
import type { TaskDiscoverySnapshot } from "./discovery";
import { peekTaskDiscovery } from "./discovery";
import {
  detectWorkspaceMatch,
  type WorkspaceMatch,
} from "./workspaceContext";

export type { ActiveTasksSnapshot };

export type ActiveTasksPayload = {
  generatedAt: string;
  activeTasks: ActiveTasksSnapshot;
  discovery: TaskDiscoverySnapshot;
};

export function loadActiveTasksPayload(
  workspace?: WorkspaceMatch
): ActiveTasksPayload {
  const ws =
    workspace ??
    detectWorkspaceMatch(undefined);
  return {
    generatedAt: new Date().toISOString(),
    activeTasks: loadActiveTasks(),
    discovery: peekTaskDiscovery(ws),
  };
}

export function activeTasksStatusBarText(payload: ActiveTasksPayload): string {
  const todos = payload.activeTasks.todos || [];
  const reconcileExtra =
    payload.discovery.missingPrs.length +
    payload.discovery.untrackedCloudAgents.length +
    payload.discovery.staleTrackedPrs.length;
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
