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
  findSemanticDuplicate,
  type ConsolidationReasonCode,
} from "./workConsolidation";
import {
  doneReasonForStatusKey,
  normalizeDoneReason,
  type DoneReason,
} from "./taskModel";
import {
  insertAfterSubtreeInOrder,
  isUnderAncestor,
  parentIdMap,
} from "./taskNestUtil";
import { planPathFromLink } from "./planLink";

export type InsertWorkResult = {
  id: string | null;
  outcome: "created" | "reused" | "refused_done" | "invalid";
  hitTitle?: string;
  reasonCode?: ConsolidationReasonCode;
};

const SCHEMA_VERSION = 3;
const TAG_VOCAB_META = "tag_vocab";
const VALID_REPOS = new Set([
  "instawork",
  "finch",
  "infrastructure",
  "other",
]);

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
  source_url: string | null;
  stream_source: string | null;
  channel: string | null;
  due: string | null;
  pr_number: number | null;
  pr_url: string | null;
  prs_json: string;
  links_json: string;
  tags_json: string;
  spec: string | null;
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

/**
 * Reject malformed JSON on write. `parseJsonArray` swallows errors so reads stay
 * lenient, which means using it to validate stores the garbage and reads it back
 * as an empty array.
 */
function validJsonArrayOrThrow(raw: string, field: string): string {
  const trimmed = raw.trim() || "[]";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${field} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON array`);
  }
  return trimmed;
}

/** Same set the CLI enforces; the two must not drift. */
export const VALID_STREAM_SOURCES = [
  "slack",
  "spark_mail",
  "github",
  "asana",
  "manual",
] as const;

function normalizeStreamSource(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (!(VALID_STREAM_SOURCES as readonly string[]).includes(trimmed)) {
    throw new Error(
      `stream_source must be one of ${VALID_STREAM_SOURCES.join(", ")}`
    );
  }
  return trimmed;
}

/** Keep `due` a plain YYYY-MM-DD so sorting is lexical and timezone-free. */
function normalizeDueDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (!match) {
    throw new Error("due must be an ISO date (YYYY-MM-DD)");
  }
  return match[1]!;
}

function rowToTodo(
  row: DbRow,
  effectiveSpec: string | null
): ParsedSessionTodo {
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
    source_url: row.source_url ?? undefined,
    stream_source: row.stream_source ?? undefined,
    channel: row.channel ?? undefined,
    due: row.due ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    spec: row.spec,
    spec_effective: effectiveSpec,
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
    todo.done_reason = normalizeDoneReason(row.done_reason);
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
  { name: "status_key", ddl: "TEXT NOT NULL DEFAULT 'backlog'" },
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

/**
 * Capture provenance, carried over when the Notion assistant dashboard was
 * folded into this table. `due` is a plain ISO date, not a timestamp.
 */
const V3_COLUMNS: { name: string; ddl: string }[] = [
  { name: "source_url", ddl: "TEXT" },
  { name: "stream_source", ddl: "TEXT" },
  { name: "channel", ddl: "TEXT" },
  { name: "due", ddl: "TEXT" },
];

const SPEC_COLUMNS: { name: string; ddl: string }[] = [
  { name: "spec", ddl: "TEXT" },
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
    if (current && current !== "other" && current !== "backlog") {
      continue;
    }
    const inferred = inferStatusKeyFromLabel(row.status);
    if (inferred !== "backlog") {
      upd.run(inferred, row.id);
    }
  }
}

/** ready / paused / other → backlog (one-time rewrite, safe to re-run). */
function migrateLegacyStatusKeys(db: Database.Database): void {
  db.prepare(
    `UPDATE active_work
     SET status_key = 'backlog'
     WHERE status_key IN ('ready', 'paused', 'other')`
  ).run();
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
  for (const col of [...V2_COLUMNS, ...V3_COLUMNS, ...SPEC_COLUMNS]) {
    if (!names.has(col.name)) {
      db.exec(`ALTER TABLE active_work ADD COLUMN ${col.name} ${col.ddl}`);
    }
  }
  const unclaimed = db
    .prepare("SELECT id, links_json FROM active_work WHERE spec IS NULL")
    .all() as { id: string; links_json: string }[];
  const setSpec = db.prepare(
    "UPDATE active_work SET spec = ? WHERE id = ? AND spec IS NULL"
  );
  for (const row of unclaimed) {
    const plan = parseJsonArray<TaskLink>(row.links_json)
      .filter((link) => link.label === "plan")
      .map(planPathFromLink)
      .find((value): value is string => Boolean(value));
    if (plan) {
      setSpec.run(plan, row.id);
    }
  }
  backfillCreatedAt(db);
  backfillStatusKeys(db);
  migrateLegacyStatusKeys(db);
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
  const script = path.join(
    os.homedir(),
    "code/cursor-contexts/scripts/active_tasks_db.py"
  );
  if (!fs.existsSync(script)) {
    return;
  }
  const python = process.env.ACTIVE_TASKS_PYTHON || "python3.11";
  const env = { ...process.env, ACTIVE_TASKS_DB_PATH: dbPath };
  try {
    execFileSync(python, [script, "import-toml-if-empty"], {
      stdio: "ignore",
      env,
    });
  } catch {
    /* import best-effort */
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
  // The Python CLI writing this same file waits 30s for a lock; without a
  // matching timeout the panel gives up first and reports a generic save failure.
  dbInstance.pragma("busy_timeout = 30000");
  ensureSchema(dbInstance);
  return dbInstance;
}

export function loadTodosFromDb(): ParsedSessionTodo[] {
  const db = openActiveTasksDb();
  const hidden = sessionHiddenIds();
  const rows = db
    .prepare(
      `SELECT * FROM active_work
       ORDER BY pinned DESC, priority ASC, sort_order ASC, updated_at DESC`
    )
    .all() as DbRow[];
  const specById = new Map(rows.map((row) => [row.id, row.spec]));
  const parentById = new Map(rows.map((row) => [row.id, row.parent_id]));
  const effectiveSpec = (rowId: string): string | null => {
    const seen = new Set<string>();
    let current: string | null = rowId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const spec = specById.get(current);
      if (spec) {
        return spec;
      }
      current = parentById.get(current) ?? null;
    }
    return null;
  };
  return rows.map((row) => {
    const todo = rowToTodo(row, effectiveSpec(row.id));
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
  // Deliberately does not touch updated_at: one drag rewrites the whole open
  // list, and bumping every row would erase the staleness signal.
  const update = db.prepare(
    "UPDATE active_work SET sort_order = ? WHERE id = ?"
  );
  const tx = db.transaction((ids: string[]) => {
    ids.forEach((id, index) => {
      update.run(index, id);
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
       ORDER BY pinned DESC, priority ASC, sort_order ASC, updated_at DESC`
    )
    .all() as { id: string; parent_id: string | null }[];
}

/**
 * Every row, not just open ones. A parent chain that passes through a done
 * task is still a cycle, so validation must see the whole table.
 */
function loadAllParentLinks(
  db: Database.Database
): { id: string; parent_id: string | null }[] {
  return db
    .prepare("SELECT id, parent_id FROM active_work")
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
    const terminalReason = doneReasonForStatusKey(sync.status_key);
    if (terminalReason) {
      setTaskDoneInDb(childId, true, terminalReason);
      return;
    }
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
  const links = loadAllParentLinks(db);
  const map = parentIdMap(links);
  if (isUnderAncestor(map, parentId, childId)) {
    return false;
  }
  db.transaction(() => {
    db.prepare(
      "UPDATE active_work SET parent_id = ?, updated_at = ? WHERE id = ?"
    ).run(parentId, nowIso(), childId);
    applyDragGroupSync(db, childId, groupSync);
    map.set(childId, parentId);
    const order = loadOpenOrderIds(db);
    reorderTasksInDb(
      insertAfterSubtreeInOrder(order, parentId, childId, map)
    );
  })();
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
    const links = loadAllParentLinks(db);
    const map = parentIdMap(links);
    map.set(childId, newParent);
    if (isUnderAncestor(map, newParent, childId)) {
      return false;
    }
  }
  db.transaction(() => {
    db.prepare(
      "UPDATE active_work SET parent_id = ?, updated_at = ? WHERE id = ?"
    ).run(newParent, nowIso(), childId);
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
  })();
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
  db.transaction(() => {
    db.prepare(
      "UPDATE active_work SET parent_id = NULL, updated_at = ? WHERE id = ?"
    ).run(nowIso(), childId);
    applyDragGroupSync(db, childId, groupSync);
    const order = loadOpenOrderIds(db).filter((id) => id !== childId);
    order.push(childId);
    reorderTasksInDb(order);
  })();
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
  const setPinned = db.prepare(
    "UPDATE active_work SET pinned = ?, updated_at = ? WHERE id = ?"
  );
  const setOrder = db.prepare(
    "UPDATE active_work SET sort_order = ? WHERE id = ?"
  );
  const tx = db.transaction((ids: string[]) => {
    setPinned.run(pinned ? 1 : 0, nowIso(), rowId);
    ids.forEach((id, index) => {
      setOrder.run(index, id);
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
  const terminalReason = doneReasonForStatusKey(fields.status_key);
  const fieldsForUpdate: TaskFieldUpdate = { ...fields };
  if (terminalReason !== null) {
    delete fieldsForUpdate.status_key;
  }
  const next = { ...existing };
  if (fieldsForUpdate.title !== undefined) {
    next.title = fieldsForUpdate.title.trim();
  }
  if (fieldsForUpdate.status !== undefined) {
    next.status = fieldsForUpdate.status.trim();
    if (fieldsForUpdate.status_key === undefined) {
      next.status_key = inferStatusKeyFromLabel(next.status);
    }
  }
  if (fieldsForUpdate.status_key !== undefined) {
    next.status_key = normalizeStatusKey(fieldsForUpdate.status_key);
  }
  if (fieldsForUpdate.priority !== undefined) {
    next.priority = clampPriority(fieldsForUpdate.priority);
  }
  if (fieldsForUpdate.pinned !== undefined) {
    next.pinned = fieldsForUpdate.pinned ? 1 : 0;
  }
  if (fieldsForUpdate.next_action !== undefined) {
    next.next_action = fieldsForUpdate.next_action.trim() || null;
  }
  if (fieldsForUpdate.waiting_on !== undefined) {
    next.waiting_on = fieldsForUpdate.waiting_on.trim() || null;
  }
  if (fieldsForUpdate.blocked_by_id !== undefined) {
    const v = fieldsForUpdate.blocked_by_id?.trim();
    next.blocked_by_id = v || null;
  }
  if (fieldsForUpdate.source_url !== undefined) {
    next.source_url = fieldsForUpdate.source_url.trim() || null;
  }
  if (fieldsForUpdate.stream_source !== undefined) {
    next.stream_source = normalizeStreamSource(fieldsForUpdate.stream_source);
  }
  if (fieldsForUpdate.channel !== undefined) {
    next.channel = fieldsForUpdate.channel.trim() || null;
  }
  if (fieldsForUpdate.due !== undefined) {
    next.due = normalizeDueDate(fieldsForUpdate.due);
  }
  if (fieldsForUpdate.parent_id !== undefined) {
    const v = fieldsForUpdate.parent_id?.trim();
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
      const links = loadAllParentLinks(db);
      const map = parentIdMap(links);
      map.set(rowId, v);
      if (isUnderAncestor(map, v, rowId)) {
        return false;
      }
    }
    next.parent_id = v || null;
  }
  if (fieldsForUpdate.cloud_agent_id !== undefined) {
    next.cloud_agent_id = fieldsForUpdate.cloud_agent_id?.trim() || null;
  }
  if (fieldsForUpdate.repo !== undefined) {
    const trimmed = fieldsForUpdate.repo.trim();
    next.repo = trimmed && VALID_REPOS.has(trimmed) ? trimmed : null;
  }
  if (fieldsForUpdate.branch !== undefined) {
    next.branch = fieldsForUpdate.branch.trim() || null;
  }
  if (fieldsForUpdate.worktree !== undefined) {
    next.worktree = fieldsForUpdate.worktree.trim() || null;
  }
  if (fieldsForUpdate.notes !== undefined) {
    next.notes = fieldsForUpdate.notes.trim() || null;
  }
  if (fieldsForUpdate.pr_number !== undefined) {
    next.pr_number = fieldsForUpdate.pr_number;
  }
  if (fieldsForUpdate.pr_url !== undefined) {
    next.pr_url = fieldsForUpdate.pr_url.trim() || null;
  }
  if (fieldsForUpdate.tags !== undefined) {
    next.tags_json = JSON.stringify(sanitizeTags(fieldsForUpdate.tags));
  }
  if (fieldsForUpdate.prs_json !== undefined) {
    next.prs_json = validJsonArrayOrThrow(fieldsForUpdate.prs_json, "prs_json");
  }
  if (fieldsForUpdate.links_json !== undefined) {
    next.links_json = validJsonArrayOrThrow(
      fieldsForUpdate.links_json,
      "links_json"
    );
  }
  next.updated_at = nowIso();
  db.prepare(`
    UPDATE active_work SET
      title = @title, status = @status, status_key = @status_key,
      priority = @priority, pinned = @pinned,
      next_action = @next_action, waiting_on = @waiting_on,
      blocked_by_id = @blocked_by_id, parent_id = @parent_id,
      cloud_agent_id = @cloud_agent_id,
      source_url = @source_url, stream_source = @stream_source,
      channel = @channel, due = @due,
      repo = @repo, branch = @branch,
      worktree = @worktree, notes = @notes, pr_number = @pr_number,
      pr_url = @pr_url, tags_json = @tags_json,
      prs_json = @prs_json, links_json = @links_json,
      updated_at = @updated_at
    WHERE id = @id
  `).run(next);
  if (fieldsForUpdate.tags !== undefined) {
    refreshTagVocab();
  }
  if (terminalReason !== null) {
    return setTaskDoneInDb(rowId, true, terminalReason);
  }
  return true;
}

export function deleteTaskFromDb(rowId: string): boolean {
  const db = openActiveTasksDb();
  const remove = db.transaction(() => {
    const ts = nowIso();
    db.prepare(
      "UPDATE active_work SET parent_id = NULL, updated_at = ? WHERE parent_id = ?"
    ).run(ts, rowId);
    db.prepare(
      "UPDATE active_work SET blocked_by_id = NULL, updated_at = ? WHERE blocked_by_id = ?"
    ).run(ts, rowId);
    return db.prepare("DELETE FROM active_work WHERE id = ?").run(rowId);
  });
  return remove().changes > 0;
}

export function setTaskDoneInDb(
  rowId: string,
  done: boolean,
  reason: DoneReason | string | null = "manual"
): boolean {
  const db = openActiveTasksDb();
  const ts = nowIso();
  const doneReason = done ? normalizeDoneReason(reason) : null;
  const result = db
    .prepare(
      `UPDATE active_work SET
        done = ?, updated_at = ?,
        done_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
        done_reason = CASE WHEN ? = 1 THEN ? ELSE NULL END,
        cloud_agent_id = CASE WHEN ? = 1 THEN NULL ELSE cloud_agent_id END
       WHERE id = ?`
    )
    .run(
      done ? 1 : 0,
      ts,
      done ? 1 : 0,
      ts,
      done ? 1 : 0,
      doneReason,
      done ? 1 : 0,
      rowId
    );
  return result.changes > 0;
}

export function insertWorkFromQuickAdd(
  title: string,
  status: string,
  repo?: string | null,
  extras?: { branch?: string | null; worktree?: string | null }
): InsertWorkResult {
  const trimmedTitle = title.trim();
  const trimmedStatus = status.trim();
  if (!trimmedTitle || !trimmedStatus) {
    return { id: null, outcome: "invalid" };
  }
  const repoVal =
    typeof repo === "string" && repo.trim() ? repo.trim() : null;
  const branchVal =
    typeof extras?.branch === "string" && extras.branch.trim()
      ? extras.branch.trim()
      : null;
  const worktreeVal =
    typeof extras?.worktree === "string" && extras.worktree.trim()
      ? extras.worktree.trim()
      : null;

  const candidate = {
    title: trimmedTitle,
    label: trimmedTitle,
    repo: repoVal,
    branch: branchVal || undefined,
    worktree: worktreeVal || undefined,
  };
  const hit = findSemanticDuplicate(candidate, loadTodosFromDb());
  if (hit) {
    const hitTitle = hit.todo.title || hit.todo.label || "task";
    if (hit.todo.done) {
      return {
        id: hit.todo.id,
        outcome: "refused_done",
        hitTitle,
        reasonCode: hit.reasonCode,
      };
    }
    return {
      id: hit.todo.id,
      outcome: "reused",
      hitTitle,
      reasonCode: hit.reasonCode,
    };
  }

  const db = openActiveTasksDb();
  const maxOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM active_work")
    .get() as { m: number };
  const id = newId();
  const ts = nowIso();
  const statusKey = inferStatusKeyFromLabel(trimmedStatus);
  db.prepare(`
    INSERT INTO active_work (
      id, sort_order, title, status, status_key, priority, pinned,
      created_at, repo, branch, worktree, prs_json, links_json, tags_json, done, updated_at
    ) VALUES (
      @id, @sort_order, @title, @status, @status_key, 1, 0,
      @created_at, @repo, @branch, @worktree, '[]', '[]', '[]', 0, @updated_at
    )
  `).run({
    id,
    sort_order: maxOrder.m + 1,
    title: trimmedTitle,
    status: trimmedStatus,
    status_key: statusKey,
    created_at: ts,
    repo: repoVal,
    branch: branchVal,
    worktree: worktreeVal,
    updated_at: ts,
  });
  return { id, outcome: "created" };
}


export function insertWorkFromOpenPr(pr: OpenGitHubPr): InsertWorkResult {
  const candidate = {
    title: pr.title,
    label: pr.title,
    repo: pr.repoKey,
    pr_number: pr.number,
    pr_url: pr.url,
  };
  const hit = findSemanticDuplicate(candidate, loadTodosFromDb());
  if (hit) {
    const hitTitle = hit.todo.title || hit.todo.label || "task";
    if (hit.todo.done) {
      return {
        id: hit.todo.id,
        outcome: "refused_done",
        hitTitle,
        reasonCode: hit.reasonCode,
      };
    }
    return {
      id: hit.todo.id,
      outcome: "reused",
      hitTitle,
      reasonCode: hit.reasonCode,
    };
  }

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
  return { id, outcome: "created" };
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
    const links = loadAllParentLinks(db);
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

/** Undo dismissals. Without this a mis-click hides an item permanently. */
export function clearDiscoveryDismissals(kind?: string): number {
  const db = openActiveTasksDb();
  const result = kind
    ? db.prepare("DELETE FROM discovery_dismiss WHERE kind = ?").run(kind)
    : db.prepare("DELETE FROM discovery_dismiss").run();
  return result.changes;
}

export function dbUpdatedAt(): string | null {
  const db = openActiveTasksDb();
  const row = db
    .prepare("SELECT MAX(updated_at) AS u FROM active_work")
    .get() as { u: string | null };
  return row.u;
}
