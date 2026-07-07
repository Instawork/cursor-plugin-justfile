import type { ParsedSessionTodo as SessionTodo } from "./taskModel";
import {
  activeTasksDbPath,
  dbUpdatedAt,
  deleteTaskFromDb,
  getMeta,
  insertWorkFromQuickAdd as insertWorkFromQuickAddInDb,
  loadTodosFromDb,
  reorderTasksInDb,
  setSessionHidden,
  setTaskDoneInDb,
  updateTaskFieldsInDb,
} from "./activeTasksStore";
import type { TaskFieldUpdate } from "./taskModel";

export type { TaskFieldUpdate, TaskLink, TaskPr, ParsedSessionTodo } from "./taskModel";
export type { ParsedSessionTodo as SessionTodo } from "./taskModel";

export type ActiveTasksSnapshot = {
  updatedAt: string | null;
  sessionId: string | null;
  source: string | null;
  tasks: string[];
  todos: SessionTodo[];
};

export function loadActiveTasks(): ActiveTasksSnapshot {
  const todos = loadTodosFromDb();
  return {
    updatedAt: dbUpdatedAt(),
    sessionId: getMeta("last_session_id"),
    source: activeTasksDbPath(),
    tasks: todos.map((t) => t.label),
    todos,
  };
}

export { activeTasksDbPath } from "./activeTasksStore";

export function reorderTasks(orderIds: string[]): boolean {
  return reorderTasksInDb(orderIds);
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
