import Database from "better-sqlite3";
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  taskRowToLabel,
  type ParsedSessionTodo,
  type TaskDragGroupSync,
  type TaskFieldUpdate,
  type TaskLink,
  type TaskPr,
} from "./taskModel";
import type { OpenGitHubPr } from "./githubOpenPrs";
import { parseTagsJson, sanitizeTags } from "./tagsUtil";
import {
  clampPriority,
  inferStatusKeyFromLabel,
  normalizeStatusKey,
  type StatusKey,
} from "./statusKeyUtil";
import {
  insertAfterSubtreeInOrder,
  isUnderAncestor,
  parentIdMap,
} from "./taskNestUtil";

const SCHEMA_VERSION = 2;
const TAG_VOCAB_META = "tag_vocab";
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
  status_key: string;
  priority: number;
  pinned: number;
  next_action: string | null;
  waiting_on: string | null;
  blocked_by_id: string | null;
  parent_id: string | null;
  cloud_agent_id: string | null;
  created_at: string;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  notes: string | null;
  pr_number: number | null;
  pr_url: string | null;
  prs_json: string;
  links_json: string;
  tags_json: string;
  done: number;
  done_at: string | null;
  done_reason: string | null;
  updated_at: string;
};

let dbInstance: Database.Database | undefined;

export function closeActiveTasksDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      /* ignore */
    }
    dbInstance = undefined;
  }
}

/** Re-run legacy TOML import when empty; returns row count after seed attempt. */
export function seedActiveWorkIfEmpty(): number {
  tryImportLegacyTomlIfEmpty();
  closeActiveTasksDb();
  openActiveTasksDb();
  return loadTodosFromDb().length;
}

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
  const tags = parseTagsJson(row.tags_json ?? "[]");
  const statusKey = normalizeStatusKey(row.status_key);
  const activeRow: Record<string, unknown> = {
    title: row.title,
    status: row.status,
    status_key: statusKey,
    repo: row.repo ?? undefined,
    branch: row.branch ?? undefined,
    worktree: row.worktree ?? undefined,
    notes: row.notes ?? undefined,
    pr_number: row.pr_number ?? undefined,
    pr_url: row.pr_url ?? undefined,
    prs: prs.length ? prs : undefined,
    links: links.length ? links : undefined,
    tags: tags.length ? tags : undefined,
    done: Boolean(row.done),
  };
  const label = taskRowToLabel(activeRow);
  const todo: ParsedSessionTodo = {
    id: row.id,
    label,
    done: Boolean(row.done),
    repo: row.repo,
    title: row.title,
    status: row.status,
    status_key: statusKey,
    priority: clampPriority(row.priority),
    pinned: Boolean(row.pinned),
    pr_number: row.pr_number ?? undefined,
    pr_url: row.pr_url ?? undefined,
    branch: row.branch ?? undefined,
    worktree: row.worktree ?? undefined,
    notes: row.notes ?? undefined,
    prs: prs.length ? prs : undefined,
    links: links.length ? links : undefined,
    tags: tags.length ? tags : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.next_action?.trim()) {
    todo.next_action = row.next_action.trim();
  }
  if (row.waiting_on?.trim()) {
    todo.waiting_on = row.waiting_on.trim();
  }
  if (row.blocked_by_id?.trim()) {
    todo.blocked_by_id = row.blocked_by_id.trim();
  }
  if (row.parent_id?.trim()) {
    todo.parent_id = row.parent_id.trim();
  }
  if (row.cloud_agent_id?.trim()) {
    todo.cloud_agent_id = row.cloud_agent_id.trim();
  }
  if (row.done_at?.trim()) {
    todo.done_at = row.done_at.trim();
  }
  if (row.done_reason?.trim()) {
    todo.done_reason = row.done_reason.trim() as ParsedSessionTodo["done_reason"];
  }
  return todo;
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
      tags_json TEXT NOT NULL DEFAULT '[]',
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
  const versionRow = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (versionRow && Number(versionRow.value) < SCHEMA_VERSION) {
    db.prepare(
      "UPDATE meta SET value = ? WHERE key = 'schema_version'"
    ).run(String(SCHEMA_VERSION));
  }
  migrateSchemaColumns(db);
}

const V2_COLUMNS: { name: string; ddl: string }[] = [
  { name: "status_key", ddl: "TEXT NOT NULL DEFAULT 'other'" },
  { name: "priority", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { name: "pinned", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { name: "next_action", ddl: "TEXT" },
  { name: "waiting_on", ddl: "TEXT" },
  { name: "blocked_by_id", ddl: "TEXT" },
  { name: "parent_id", ddl: "TEXT" },
  { name: "cloud_agent_id", ddl: "TEXT" },
  { name: "created_at", ddl: "TEXT" },
  { name: "done_at", ddl: "TEXT" },
  { name: "done_reason", ddl: "TEXT" },
];

function backfillStatusKeys(db: Database.Database): void {
  const rows = db
    .prepare("SELECT id, status, status_key FROM active_work")
    .all() as { id: string; status: string; status_key: string }[];
  const upd = db.prepare(
    "UPDATE active_work SET status_key = ? WHERE id = ?"
  );
  for (const row of rows) {
    const current = row.status_key?.trim();
    if (current && current !== "other") {
      continue;
    }
    const inferred = inferStatusKeyFromLabel(row.status);
    if (inferred !== "other") {
      upd.run(inferred, row.id);
    }
  }
}

function backfillCreatedAt(db: Database.Database): void {
  db.prepare(`
    UPDATE active_work
    SET created_at = updated_at
    WHERE created_at IS NULL OR TRIM(created_at) = ''
  `).run();
}

function migrateSchemaColumns(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(active_work)")
    .all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("tags_json")) {
    db.exec(
      `ALTER TABLE active_work ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`
    );
  }
  for (const col of V2_COLUMNS) {
    if (!names.has(col.name)) {
      db.exec(`ALTER TABLE active_work ADD COLUMN ${col.name} ${col.ddl}`);
    }
  }
  backfillCreatedAt(db);
  backfillStatusKeys(db);
}

function collectTagsFromDb(db: Database.Database): string[] {
  const set = new Set<string>();
  const metaRow = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(TAG_VOCAB_META) as { value: string } | undefined;
  for (const t of parseTagsJson(metaRow?.value ?? "[]")) {
    set.add(t);
  }
  const rows = db
    .prepare("SELECT tags_json FROM active_work")
    .all() as { tags_json: string }[];
  for (const row of rows) {
    for (const t of parseTagsJson(row.tags_json)) {
      set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function refreshTagVocab(): string[] {
  const db = openActiveTasksDb();
  const vocab = collectTagsFromDb(db);
  setMeta(TAG_VOCAB_META, JSON.stringify(vocab));
  return vocab;
}

export function listTagVocab(): string[] {
  const db = openActiveTasksDb();
  return collectTagsFromDb(db);
}

function tryImportLegacyTomlIfEmpty(): void {
  if (process.env.ACTIVE_TASKS_SKIP_LEGACY_IMPORT === "1") {
    return;
  }
  const dbPath = activeTasksDbPath();
  if (fs.existsSync(dbPath)) {
    const probe = new Database(dbPath, { readonly: true });
    try {
      const row = probe
        .prepare("SELECT COUNT(*) as c FROM active_work")
        .get() as { c: number };
      if (row.c > 0) {
        return;
      }
    } catch {
      /* empty or corrupt — import may still help */
    } finally {
      probe.close();
    }
  }
  const scripts = [
    path.join(
      os.homedir(),
      "code/cursor-contexts/scripts/active_tasks_db.py"
    ),
    path.join(__dirname, "..", "bundled", "hooks", "active_tasks_db.py"),
  ];
  const python = process.env.ACTIVE_TASKS_PYTHON || "python3.11";
  const env = { ...process.env, ACTIVE_TASKS_DB_PATH: dbPath };
  for (const script of scripts) {
    if (!fs.existsSync(script)) {
      continue;
    }
    try {
      execFileSync(python, [script, "import-toml-if-empty"], {
        stdio: "ignore",
        env,
      });
      return;
    } catch {
      /* try next script */
    }
  }
}

export function openActiveTasksDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }
  tryImportLegacyTomlIfEmpty();
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
      `SELECT * FROM active_work
       ORDER BY pinned DESC, priority DESC, sort_order ASC, updated_at DESC`
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

function loadOpenParentLinks(
  db: Database.Database
): { id: string; parent_id: string | null }[] {
  return db
    .prepare(
      `SELECT id, parent_id FROM active_work WHERE done = 0
       ORDER BY pinned DESC, priority DESC, sort_order ASC, updated_at DESC`
    )
    .all() as { id: string; parent_id: string | null }[];
}

function loadOpenOrderIds(db: Database.Database): string[] {
  return loadOpenParentLinks(db).map((r) => r.id);
}

function applyDragGroupSync(
  db: Database.Database,
  childId: string,
  sync: TaskDragGroupSync | undefined
): void {
  if (!sync) {
    return;
  }
  const ts = nowIso();
  const sets: string[] = ["updated_at = @updated_at"];
  const params: Record<string, string | null> = {
    id: childId,
    updated_at: ts,
  };
  if (sync.repo !== undefined) {
    sets.push("repo = @repo");
    const trimmed =
      typeof sync.repo === "string" ? sync.repo.trim() : sync.repo;
    params.repo =
      trimmed && VALID_REPOS.has(trimmed) ? trimmed : null;
  }
  if (sync.status !== undefined) {
    sets.push("status = @status");
    params.status = sync.status.trim();
  }
  if (sync.status_key !== undefined) {
    sets.push("status_key = @status_key");
    params.status_key = normalizeStatusKey(sync.status_key);
  }
  if (sets.length <= 1) {
    return;
  }
  db.prepare(
    `UPDATE active_work SET ${sets.join(", ")} WHERE id = @id`
  ).run(params);
}

export function nestTaskUnderInDb(
  childId: string,
  parentId: string,
  groupSync?: TaskDragGroupSync
): boolean {
  if (childId === parentId) {
    return false;
  }
  const db = openActiveTasksDb();
  const child = db
    .prepare("SELECT id, done FROM active_work WHERE id = ?")
    .get(childId) as { id: string; done: number } | undefined;
  const parent = db
    .prepare("SELECT id, done FROM active_work WHERE id = ?")
    .get(parentId) as { id: string; done: number } | undefined;
  if (!child || child.done || !parent || parent.done) {
    return false;
  }
  const links = loadOpenParentLinks(db);
  const map = parentIdMap(links);
  if (isUnderAncestor(map, parentId, childId)) {
    return false;
  }
  const ts = nowIso();
  db.prepare(
    "UPDATE active_work SET parent_id = ?, updated_at = ? WHERE id = ?"
  ).run(parentId, ts, childId);
  applyDragGroupSync(db, childId, groupSync);
  map.set(childId, parentId);
  const order = loadOpenOrderIds(db);
  const next = insertAfterSubtreeInOrder(order, parentId, childId, map);
  reorderTasksInDb(next);
  return true;
}

export function moveTaskSiblingInDb(
  childId: string,
  targetId: string,
  after: boolean,
  groupSync?: TaskDragGroupSync
): boolean {
  if (childId === targetId) {
    return false;
  }
  const db = openActiveTasksDb();
  const child = db
    .prepare("SELECT id, done FROM active_work WHERE id = ?")
    .get(childId) as { id: string; done: number } | undefined;
  const target = db
    .prepare("SELECT id, done, parent_id FROM active_work WHERE id = ?")
    .get(targetId) as
    | { id: string; done: number; parent_id: string | null }
    | undefined;
  if (!child || child.done || !target || target.done) {
    return false;
  }
  const newParent = target.parent_id?.trim() || null;
  if (newParent) {
    const parentRow = db
      .prepare("SELECT id, done FROM active_work WHERE id = ?")
      .get(newParent) as { id: string; done: number } | undefined;
    if (!parentRow || parentRow.done) {
      return false;
    }
    const links = loadOpenParentLinks(db);
    const map = parentIdMap(links);
    map.set(childId, newParent);
    if (isUnderAncestor(map, newParent, childId)) {
      return false;
    }
  }
  const ts = nowIso();
  db.prepare(
    "UPDATE active_work SET parent_id = ?, updated_at = ? WHERE id = ?"
  ).run(newParent, ts, childId);
  applyDragGroupSync(db, childId, groupSync);
  const order = loadOpenOrderIds(db).filter((id) => id !== childId);
  let idx = order.indexOf(targetId);
  if (idx < 0) {
    order.push(childId);
  } else {
    if (after) {
      idx += 1;
    }
    order.splice(idx, 0, childId);
  }
  reorderTasksInDb(order);
  return true;
}

export function moveTaskToSectionInDb(
  childId: string,
  groupSync: TaskDragGroupSync
): boolean {
  const db = openActiveTasksDb();
  const child = db
    .prepare("SELECT id, done FROM active_work WHERE id = ?")
    .get(childId) as { id: string; done: number } | undefined;
  if (!child || child.done) {
    return false;
  }
  const ts = nowIso();
  db.prepare(
    "UPDATE active_work SET parent_id = NULL, updated_at = ? WHERE id = ?"
  ).run(ts, childId);
  applyDragGroupSync(db, childId, groupSync);
  const order = loadOpenOrderIds(db).filter((id) => id !== childId);
  order.push(childId);
  reorderTasksInDb(order);
  return true;
}

/** Pin or unpin a row and reorder so pinned tasks stay in the Pinned section (top of open list). */
export function setTaskPinnedInDb(rowId: string, pinned: boolean): boolean {
  const db = openActiveTasksDb();
  const row = db
    .prepare("SELECT id, done FROM active_work WHERE id = ?")
    .get(rowId) as { id: string; done: number } | undefined;
  if (!row || row.done) {
    return false;
  }
  const openRows = db
    .prepare(
      `SELECT id, pinned FROM active_work WHERE done = 0
       ORDER BY pinned DESC, sort_order ASC, updated_at DESC`
    )
    .all() as { id: string; pinned: number }[];
  const without = openRows.map((r) => r.id).filter((id) => id !== rowId);
  const pinnedIds = without.filter(
    (id) => openRows.find((r) => r.id === id)?.pinned
  );
  const unpinnedIds = without.filter((id) => !pinnedIds.includes(id));
  const newOrder = pinned
    ? [rowId, ...pinnedIds, ...unpinnedIds]
    : [...pinnedIds, rowId, ...unpinnedIds];
  const ts = nowIso();
  db.prepare(
    "UPDATE active_work SET pinned = ?, updated_at = ? WHERE id = ?"
  ).run(pinned ? 1 : 0, ts, rowId);
  const update = db.prepare(
    "UPDATE active_work SET sort_order = ?, updated_at = ? WHERE id = ?"
  );
  const tx = db.transaction((ids: string[]) => {
    ids.forEach((id, index) => {
      update.run(index, ts, id);
    });
  });
  tx(newOrder);
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
    if (fields.status_key === undefined) {
      next.status_key = inferStatusKeyFromLabel(next.status);
    }
  }
  if (fields.status_key !== undefined) {
    next.status_key = normalizeStatusKey(fields.status_key);
  }
  if (fields.priority !== undefined) {
    next.priority = clampPriority(fields.priority);
  }
  if (fields.pinned !== undefined) {
    next.pinned = fields.pinned ? 1 : 0;
  }
  if (fields.next_action !== undefined) {
    next.next_action = fields.next_action.trim() || null;
  }
  if (fields.waiting_on !== undefined) {
    next.waiting_on = fields.waiting_on.trim() || null;
  }
  if (fields.blocked_by_id !== undefined) {
    const v = fields.blocked_by_id?.trim();
    next.blocked_by_id = v || null;
  }
  if (fields.parent_id !== undefined) {
    const v = fields.parent_id?.trim();
    if (v && v === rowId) {
      return false;
    }
    if (v) {
      const parentRow = db
        .prepare("SELECT id, done FROM active_work WHERE id = ?")
        .get(v) as { id: string; done: number } | undefined;
      if (!parentRow || parentRow.done) {
        return false;
      }
      const links = loadOpenParentLinks(db);
      const map = parentIdMap(links);
      map.set(rowId, v);
      if (isUnderAncestor(map, v, rowId)) {
        return false;
      }
    }
    next.parent_id = v || null;
  }
  if (fields.cloud_agent_id !== undefined) {
    next.cloud_agent_id = fields.cloud_agent_id?.trim() || null;
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
  if (fields.tags !== undefined) {
    next.tags_json = JSON.stringify(sanitizeTags(fields.tags));
  }
  if (fields.prs_json !== undefined) {
    const raw = fields.prs_json.trim() || "[]";
    parseJsonArray<TaskPr>(raw);
    next.prs_json = raw;
  }
  if (fields.links_json !== undefined) {
    const raw = fields.links_json.trim() || "[]";
    parseJsonArray<TaskLink>(raw);
    next.links_json = raw;
  }
  next.updated_at = nowIso();
  db.prepare(`
    UPDATE active_work SET
      title = @title, status = @status, status_key = @status_key,
      priority = @priority, pinned = @pinned,
      next_action = @next_action, waiting_on = @waiting_on,
      blocked_by_id = @blocked_by_id, parent_id = @parent_id,
      cloud_agent_id = @cloud_agent_id,
      repo = @repo, branch = @branch,
      worktree = @worktree, notes = @notes, pr_number = @pr_number,
      pr_url = @pr_url, tags_json = @tags_json,
      prs_json = @prs_json, links_json = @links_json,
      updated_at = @updated_at
    WHERE id = @id
  `).run(next);
  if (fields.tags !== undefined) {
    refreshTagVocab();
  }
  return true;
}

export function deleteTaskFromDb(rowId: string): boolean {
  const db = openActiveTasksDb();
  db.prepare(
    "UPDATE active_work SET parent_id = NULL, updated_at = ? WHERE parent_id = ?"
  ).run(nowIso(), rowId);
  const result = db.prepare("DELETE FROM active_work WHERE id = ?").run(rowId);
  return result.changes > 0;
}

export function setTaskDoneInDb(
  rowId: string,
  done: boolean,
  reason: string | null = "manual"
): boolean {
  const db = openActiveTasksDb();
  const ts = nowIso();
  const result = db
    .prepare(
      `UPDATE active_work SET
        done = ?, updated_at = ?,
        done_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
        done_reason = CASE WHEN ? = 1 THEN ? ELSE NULL END
       WHERE id = ?`
    )
    .run(
      done ? 1 : 0,
      ts,
      done ? 1 : 0,
      ts,
      done ? 1 : 0,
      reason,
      rowId
    );
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
  const ts = nowIso();
  const statusKey = inferStatusKeyFromLabel(trimmedStatus);
  db.prepare(`
    INSERT INTO active_work (
      id, sort_order, title, status, status_key, priority, pinned,
      created_at, repo, prs_json, links_json, tags_json, done, updated_at
    ) VALUES (
      @id, @sort_order, @title, @status, @status_key, 1, 0,
      @created_at, @repo, '[]', '[]', '[]', 0, @updated_at
    )
  `).run({
    id,
    sort_order: maxOrder.m + 1,
    title: trimmedTitle,
    status: trimmedStatus,
    status_key: statusKey,
    created_at: ts,
    repo: repoVal,
    updated_at: ts,
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
  const statusKey: StatusKey =
    pr.relation === "review_requested" ? "review" : "progress";
  const ts = nowIso();
  db.prepare(`
    INSERT INTO active_work (
      id, sort_order, title, status, status_key, priority, pinned,
      created_at, repo, pr_number, pr_url,
      prs_json, links_json, tags_json, done, updated_at
    ) VALUES (
      @id, @sort_order, @title, @status, @status_key, 1, 0,
      @created_at, @repo, @pr_number, @pr_url,
      '[]', '[]', '[]', 0, @updated_at
    )
  `).run({
    id,
    sort_order: maxOrder.m + 1,
    title: pr.title,
    status,
    status_key: statusKey,
    created_at: ts,
    repo: pr.repoKey,
    pr_number: pr.number,
    pr_url: pr.url,
    updated_at: ts,
  });
  return id;
}

/** Nest related rows under one initiative (parent_id); keeps each row's own fields. */
export function mergeWorkRowsIntoPrimary(
  primaryId: string,
  mergeIds: string[]
): boolean {
  const sources = mergeIds.filter((id) => id && id !== primaryId);
  if (!sources.length) {
    return false;
  }
  const db = openActiveTasksDb();
  const primary = db
    .prepare("SELECT id, done FROM active_work WHERE id = ?")
    .get(primaryId) as { id: string; done: number } | undefined;
  if (!primary || primary.done) {
    return false;
  }

  const nest = db.transaction(() => {
    const links = loadOpenParentLinks(db);
    const map = parentIdMap(links);
    let order = loadOpenOrderIds(db);
    const ts = nowIso();

    for (const sourceId of sources) {
      const row = db
        .prepare("SELECT id, done FROM active_work WHERE id = ?")
        .get(sourceId) as { id: string; done: number } | undefined;
      if (!row || row.done) {
        continue;
      }
      if (isUnderAncestor(map, primaryId, sourceId)) {
        throw new Error("merge would create a parent cycle");
      }
      db.prepare(
        "UPDATE active_work SET parent_id = ?, updated_at = ? WHERE id = ?"
      ).run(primaryId, ts, sourceId);
      map.set(sourceId, primaryId);
      order = insertAfterSubtreeInOrder(order, primaryId, sourceId, map);
    }

    reorderTasksInDb(order);
  });

  try {
    nest();
    return true;
  } catch {
    return false;
  }
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
