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
} from "./activeTasksStore";
import type { TaskFieldUpdate, TaskDragGroupSync } from "./taskModel";

export type { TaskFieldUpdate, TaskLink, TaskPr, ParsedSessionTodo } from "./taskModel";
export type { ParsedSessionTodo as SessionTodo } from "./taskModel";

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
  repo?: string | null
): string | null {
  return insertWorkFromQuickAddInDb(title, status, repo);
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
  mode: "session" | "remove" | "archive"
): boolean {
  if (mode === "remove") {
    return deleteTaskFromDb(todoId);
  }
  if (mode === "archive") {
    setSessionHidden(todoId, false);
    return setTaskDoneInDb(todoId, true);
  }
  return setSessionHidden(todoId, true);
}
