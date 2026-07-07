import Database from "better-sqlite3";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  taskRowToLabel,
  type ParsedSessionTodo,
  type TaskFieldUpdate,
  type TaskLink,
  type TaskPr,
} from "./taskModel";
import type { OpenGitHubPr } from "./githubOpenPrs";

const SCHEMA_VERSION = 1;
const VALID_REPOS = new Set(["instawork", "finch", "infrastructure"]);

export function activeTasksDbPath(): string {
  return (
    process.env.ACTIVE_TASKS_DB_PATH ||
    path.join(os.homedir(), "code/cursor-contexts/active-tasks.sqlite")
  );
}

type DbRow = {
  id: string;
  sort_order: number;
  title: string;
  status: string;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  notes: string | null;
  pr_number: number | null;
  pr_url: string | null;
  prs_json: string;
  links_json: string;
  done: number;
  updated_at: string;
};

let dbInstance: Database.Database | undefined;

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function rowToTodo(row: DbRow): ParsedSessionTodo {
  const prs = parseJsonArray<TaskPr>(row.prs_json);
  const links = parseJsonArray<TaskLink>(row.links_json);
  const activeRow: Record<string, unknown> = {
    title: row.title,
    status: row.status,
    repo: row.repo ?? undefined,
    branch: row.branch ?? undefined,
    worktree: row.worktree ?? undefined,
    notes: row.notes ?? undefined,
    pr_number: row.pr_number ?? undefined,
    pr_url: row.pr_url ?? undefined,
    prs: prs.length ? prs : undefined,
    links: links.length ? links : undefined,
    done: Boolean(row.done),
  };
  const label = taskRowToLabel(activeRow);
  return {
    id: row.id,
    label,
    done: Boolean(row.done),
    repo: row.repo,
    title: row.title,
    status: row.status,
    pr_number: row.pr_number ?? undefined,
    pr_url: row.pr_url ?? undefined,
    branch: row.branch ?? undefined,
    worktree: row.worktree ?? undefined,
    notes: row.notes ?? undefined,
    prs: prs.length ? prs : undefined,
    links: links.length ? links : undefined,
  };
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS active_work (
      id TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      repo TEXT,
      branch TEXT,
      worktree TEXT,
      notes TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      prs_json TEXT NOT NULL DEFAULT '[]',
      links_json TEXT NOT NULL DEFAULT '[]',
      done INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_active_work_sort ON active_work(sort_order);
    CREATE TABLE IF NOT EXISTS discovery_dismiss (
      kind TEXT NOT NULL,
      ref_key TEXT NOT NULL,
      PRIMARY KEY (kind, ref_key)
    );
    CREATE TABLE IF NOT EXISTS session_hidden (
      work_id TEXT PRIMARY KEY,
      FOREIGN KEY (work_id) REFERENCES active_work(id) ON DELETE CASCADE
    );
  `);
  db.prepare(
    "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)"
  ).run(String(SCHEMA_VERSION));
}

export function openActiveTasksDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }
  const dbPath = activeTasksDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  dbInstance = new Database(dbPath);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");
  ensureSchema(dbInstance);
  return dbInstance;
}

export function loadTodosFromDb(): ParsedSessionTodo[] {
  const db = openActiveTasksDb();
  const hidden = sessionHiddenIds();
  const rows = db
    .prepare(
      "SELECT * FROM active_work ORDER BY sort_order ASC, updated_at DESC"
    )
    .all() as DbRow[];
  return rows.map((row) => {
    const todo = rowToTodo(row);
    if (hidden.has(row.id)) {
      todo.done = true;
    }
    return todo;
  });
}

export function sessionHiddenIds(): Set<string> {
  const db = openActiveTasksDb();
  const rows = db
    .prepare("SELECT work_id FROM session_hidden")
    .all() as { work_id: string }[];
  return new Set(rows.map((r) => r.work_id));
}

export function setSessionHidden(workId: string, hidden: boolean): boolean {
  const db = openActiveTasksDb();
  const exists = db
    .prepare("SELECT 1 FROM active_work WHERE id = ?")
    .get(workId);
  if (!exists) {
    return false;
  }
  if (hidden) {
    db.prepare("INSERT OR IGNORE INTO session_hidden (work_id) VALUES (?)").run(
      workId
    );
  } else {
    db.prepare("DELETE FROM session_hidden WHERE work_id = ?").run(workId);
  }
  return true;
}

export function clearSessionHidden(): void {
  const db = openActiveTasksDb();
  db.prepare("DELETE FROM session_hidden").run();
}

export function setMeta(key: string, value: string): void {
  const db = openActiveTasksDb();
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
  ).run(key, value);
}

export function getMeta(key: string): string | null {
  const db = openActiveTasksDb();
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function reorderTasksInDb(orderIds: string[]): boolean {
  const db = openActiveTasksDb();
  const update = db.prepare(
    "UPDATE active_work SET sort_order = ?, updated_at = ? WHERE id = ?"
  );
  const tx = db.transaction((ids: string[]) => {
    const ts = nowIso();
    ids.forEach((id, index) => {
      update.run(index, ts, id);
    });
  });
  tx(orderIds);
  return true;
}

export function updateTaskFieldsInDb(
  rowId: string,
  fields: TaskFieldUpdate
): boolean {
  const db = openActiveTasksDb();
  const existing = db
    .prepare("SELECT * FROM active_work WHERE id = ?")
    .get(rowId) as DbRow | undefined;
  if (!existing) {
    return false;
  }
  const next = { ...existing };
  if (fields.title !== undefined) {
    next.title = fields.title.trim();
  }
  if (fields.status !== undefined) {
    next.status = fields.status.trim();
  }
  if (fields.repo !== undefined) {
    const trimmed = fields.repo.trim();
    next.repo = trimmed && VALID_REPOS.has(trimmed) ? trimmed : null;
  }
  if (fields.branch !== undefined) {
    next.branch = fields.branch.trim() || null;
  }
  if (fields.worktree !== undefined) {
    next.worktree = fields.worktree.trim() || null;
  }
  if (fields.notes !== undefined) {
    next.notes = fields.notes.trim() || null;
  }
  if (fields.pr_number !== undefined) {
    next.pr_number = fields.pr_number;
  }
  if (fields.pr_url !== undefined) {
    next.pr_url = fields.pr_url.trim() || null;
  }
  next.updated_at = nowIso();
  db.prepare(`
    UPDATE active_work SET
      title = @title, status = @status, repo = @repo, branch = @branch,
      worktree = @worktree, notes = @notes, pr_number = @pr_number,
      pr_url = @pr_url, updated_at = @updated_at
    WHERE id = @id
  `).run(next);
  return true;
}

export function deleteTaskFromDb(rowId: string): boolean {
  const db = openActiveTasksDb();
  const result = db.prepare("DELETE FROM active_work WHERE id = ?").run(rowId);
  return result.changes > 0;
}

export function setTaskDoneInDb(rowId: string, done: boolean): boolean {
  const db = openActiveTasksDb();
  const result = db
    .prepare(
      "UPDATE active_work SET done = ?, updated_at = ? WHERE id = ?"
    )
    .run(done ? 1 : 0, nowIso(), rowId);
  return result.changes > 0;
}

export function insertWorkFromQuickAdd(
  title: string,
  status: string,
  repo?: string | null
): string | null {
  const trimmedTitle = title.trim();
  const trimmedStatus = status.trim();
  if (!trimmedTitle || !trimmedStatus) {
    return null;
  }
  const db = openActiveTasksDb();
  const maxOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM active_work")
    .get() as { m: number };
  const id = newId();
  const repoVal =
    typeof repo === "string" && repo.trim() ? repo.trim() : null;
  db.prepare(`
    INSERT INTO active_work (
      id, sort_order, title, status, repo, prs_json, links_json, done, updated_at
    ) VALUES (
      @id, @sort_order, @title, @status, @repo, '[]', '[]', 0, @updated_at
    )
  `).run({
    id,
    sort_order: maxOrder.m + 1,
    title: trimmedTitle,
    status: trimmedStatus,
    repo: repoVal,
    updated_at: nowIso(),
  });
  return id;
}

export function insertWorkFromOpenPr(pr: OpenGitHubPr): string | null {
  const db = openActiveTasksDb();
  const maxOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM active_work")
    .get() as { m: number };
  const id = newId();
  const status =
    pr.relation === "review_requested"
      ? "review"
      : pr.isDraft
        ? "draft PR"
        : "open PR";
  db.prepare(`
    INSERT INTO active_work (
      id, sort_order, title, status, repo, pr_number, pr_url,
      prs_json, links_json, done, updated_at
    ) VALUES (
      @id, @sort_order, @title, @status, @repo, @pr_number, @pr_url,
      '[]', '[]', 0, @updated_at
    )
  `).run({
    id,
    sort_order: maxOrder.m + 1,
    title: pr.title,
    status,
    repo: pr.repoKey,
    pr_number: pr.number,
    pr_url: pr.url,
    updated_at: nowIso(),
  });
  return id;
}

export function attachOpenPrToWork(
  workId: string,
  pr: OpenGitHubPr
): boolean {
  const db = openActiveTasksDb();
  const row = db
    .prepare("SELECT * FROM active_work WHERE id = ?")
    .get(workId) as DbRow | undefined;
  if (!row) {
    return false;
  }
  const prs = parseJsonArray<TaskPr>(row.prs_json);
  if (!row.pr_number && !row.pr_url) {
    db.prepare(`
      UPDATE active_work SET pr_number = ?, pr_url = ?, updated_at = ?
      WHERE id = ?
    `).run(pr.number, pr.url, nowIso(), workId);
    return true;
  }
  if (prs.some((p) => p.url === pr.url || p.number === pr.number)) {
    return false;
  }
  prs.push({
    number: pr.number,
    url: pr.url,
    repo: pr.repoKey,
  });
  db.prepare(
    "UPDATE active_work SET prs_json = ?, updated_at = ? WHERE id = ?"
  ).run(JSON.stringify(prs), nowIso(), workId);
  return true;
}

export function listDiscoveryDismissals(): Set<string> {
  const db = openActiveTasksDb();
  const rows = db
    .prepare("SELECT kind, ref_key FROM discovery_dismiss")
    .all() as { kind: string; ref_key: string }[];
  return new Set(rows.map((r) => `${r.kind}:${r.ref_key}`));
}

export function dismissDiscovery(kind: string, refKey: string): void {
  const db = openActiveTasksDb();
  db.prepare(
    "INSERT OR IGNORE INTO discovery_dismiss (kind, ref_key) VALUES (?, ?)"
  ).run(kind, refKey);
}

export function dbUpdatedAt(): string | null {
  const db = openActiveTasksDb();
  const row = db
    .prepare("SELECT MAX(updated_at) AS u FROM active_work")
    .get() as { u: string | null };
  return row.u;
}
