import type { ParsedSessionTodo as SessionTodo } from "./taskModel";
import {
  activeTasksDbPath,
  dbUpdatedAt,
  deleteTaskFromDb,
  getMeta,
  insertWorkFromQuickAdd as insertWorkFromQuickAddInDb,
  loadTodosFromDb,
  listTagVocab,
  reorderTasksInDb,
  moveTaskSiblingInDb,
  moveTaskToSectionInDb,
  nestTaskUnderInDb,
  setSessionHidden,
  setTaskDoneInDb,
  setTaskPinnedInDb,
  updateTaskFieldsInDb,
  type InsertWorkResult,
} from "./activeTasksStore";
import type { TaskFieldUpdate, TaskDragGroupSync, DoneReason } from "./taskModel";
import { normalizeDoneReason } from "./taskModel";

export type { TaskFieldUpdate, TaskLink, TaskPr, ParsedSessionTodo } from "./taskModel";
export type { ParsedSessionTodo as SessionTodo } from "./taskModel";
export type { InsertWorkResult } from "./activeTasksStore";

export type ActiveTasksSnapshot = {
  updatedAt: string | null;
  sessionId: string | null;
  source: string | null;
  tasks: string[];
  tagVocab: string[];
  todos: SessionTodo[];
};

export function loadActiveTasks(): ActiveTasksSnapshot {
  const todos = loadTodosFromDb();
  return {
    updatedAt: dbUpdatedAt(),
    sessionId: getMeta("last_session_id"),
    source: activeTasksDbPath(),
    tasks: todos.map((t) => t.label),
    tagVocab: listTagVocab(),
    todos,
  };
}

export { activeTasksDbPath } from "./activeTasksStore";

export function reorderTasks(orderIds: string[]): boolean {
  return reorderTasksInDb(orderIds);
}

export function nestTaskUnder(
  childId: string,
  parentId: string,
  groupSync?: TaskDragGroupSync
): boolean {
  return nestTaskUnderInDb(childId, parentId, groupSync);
}

export function moveTaskSibling(
  childId: string,
  targetId: string,
  after: boolean,
  groupSync?: TaskDragGroupSync
): boolean {
  return moveTaskSiblingInDb(childId, targetId, after, groupSync);
}

export function moveTaskToSection(
  childId: string,
  groupSync: TaskDragGroupSync
): boolean {
  return moveTaskToSectionInDb(childId, groupSync);
}

export function setTaskPinned(todoId: string, pinned: boolean): boolean {
  return setTaskPinnedInDb(todoId, pinned);
}

export function insertWorkFromQuickAdd(
  title: string,
  status: string,
  repo?: string | null,
  extras?: { branch?: string | null; worktree?: string | null }
): InsertWorkResult {
  return insertWorkFromQuickAddInDb(title, status, repo, extras);
}

export function updateTaskFields(
  rowId: string,
  fields: TaskFieldUpdate
): boolean {
  return updateTaskFieldsInDb(rowId, fields);
}

export function removeTaskRow(rowId: string): boolean {
  return deleteTaskFromDb(rowId);
}

export function setTodoDone(todoId: string, done: boolean): boolean {
  if (done) {
    return setSessionHidden(todoId, true);
  }
  setSessionHidden(todoId, false);
  return setTaskDoneInDb(todoId, false);
}

export function setTodoDonePersistent(
  todoId: string,
  mode: "session" | "remove" | "done" | "archive",
  reason: DoneReason | string | null = "manual"
): boolean {
  if (mode === "remove") {
    return deleteTaskFromDb(todoId);
  }
  // "archive" kept as a synonym for one webview reload after rename.
  if (mode === "done" || mode === "archive") {
    setSessionHidden(todoId, false);
    return setTaskDoneInDb(todoId, true, normalizeDoneReason(reason));
  }
  return setSessionHidden(todoId, true);
}
