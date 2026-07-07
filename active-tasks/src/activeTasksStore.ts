import Database from "better-sqlite3";
import { execFileSync } from "child_process";
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
import { parseTagsJson, sanitizeTags } from "./tagsUtil";

const SCHEMA_VERSION = 1;
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
  const tags = parseTagsJson(row.tags_json ?? "[]");
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
    tags: tags.length ? tags : undefined,
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
    tags: tags.length ? tags : undefined,
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
  migrateSchemaColumns(db);
}

function migrateSchemaColumns(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(active_work)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "tags_json")) {
    db.exec(
      `ALTER TABLE active_work ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`
    );
  }
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
  if (fields.tags !== undefined) {
    next.tags_json = JSON.stringify(sanitizeTags(fields.tags));
  }
  next.updated_at = nowIso();
  db.prepare(`
    UPDATE active_work SET
      title = @title, status = @status, repo = @repo, branch = @branch,
      worktree = @worktree, notes = @notes, pr_number = @pr_number,
      pr_url = @pr_url, tags_json = @tags_json, updated_at = @updated_at
    WHERE id = @id
  `).run(next);
  if (fields.tags !== undefined) {
    refreshTagVocab();
  }
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

function prEntryKey(pr: TaskPr): string {
  const url = pr.url?.trim();
  if (url) {
    return url;
  }
  const repo = pr.repo ?? "";
  return `${repo}#${pr.number}`;
}

function appendPr(list: TaskPr[], entry: TaskPr, seen: Set<string>): void {
  const key = prEntryKey(entry);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  list.push(entry);
}

function rowPrimaryAsPr(row: DbRow): TaskPr | null {
  if (row.pr_number === null || !row.pr_url?.trim()) {
    return null;
  }
  return {
    number: row.pr_number,
    url: row.pr_url.trim(),
    repo: row.repo,
  };
}

/** Fold related rows into one initiative (extra PRs → prs_json). */
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
    .prepare("SELECT * FROM active_work WHERE id = ?")
    .get(primaryId) as DbRow | undefined;
  if (!primary) {
    return false;
  }

  const merge = db.transaction(() => {
    let prs = parseJsonArray<TaskPr>(primary.prs_json);
    const links = parseJsonArray<TaskLink>(primary.links_json);
    const seenPr = new Set<string>();
    for (const p of prs) {
      seenPr.add(prEntryKey(p));
    }
    let prNumber = primary.pr_number;
    let prUrl = primary.pr_url;
    let repo = primary.repo;
    let branch = primary.branch;
    let worktree = primary.worktree;
    let notes = primary.notes?.trim() ?? "";
    let sortOrder = primary.sort_order;
    const linkSeen = new Set(links.map((l) => l.url.trim()));
    const tagKeys = new Set<string>();
    const mergedTags: string[] = [];
    const addTag = (tag: string): void => {
      const key = tag.toLowerCase();
      if (tagKeys.has(key)) {
        return;
      }
      tagKeys.add(key);
      mergedTags.push(tag);
    };
    for (const t of parseTagsJson(primary.tags_json ?? "[]")) {
      addTag(t);
    }

    for (const sourceId of sources) {
      const row = db
        .prepare("SELECT * FROM active_work WHERE id = ?")
        .get(sourceId) as DbRow | undefined;
      if (!row) {
        continue;
      }
      sortOrder = Math.min(sortOrder, row.sort_order);

      for (const p of parseJsonArray<TaskPr>(row.prs_json)) {
        appendPr(prs, p, seenPr);
      }
      const sourcePrimary = rowPrimaryAsPr(row);
      if (sourcePrimary) {
        if (prNumber === null) {
          prNumber = row.pr_number;
          prUrl = row.pr_url;
        } else {
          appendPr(prs, sourcePrimary, seenPr);
        }
      }

      if (!repo && row.repo) {
        repo = row.repo;
      }
      if (!branch?.trim() && row.branch?.trim()) {
        branch = row.branch.trim();
      }
      if (!worktree?.trim() && row.worktree?.trim()) {
        worktree = row.worktree.trim();
      }
      const extraNotes = row.notes?.trim();
      if (extraNotes && !notes.includes(extraNotes)) {
        notes = notes ? `${notes}\n${extraNotes}` : extraNotes;
      }
      for (const link of parseJsonArray<TaskLink>(row.links_json)) {
        const u = link.url?.trim();
        if (u && !linkSeen.has(u)) {
          linkSeen.add(u);
          links.push(link);
        }
      }
      for (const tag of parseTagsJson(row.tags_json ?? "[]")) {
        addTag(tag);
      }

      db.prepare("DELETE FROM session_hidden WHERE work_id = ?").run(sourceId);
      db.prepare("DELETE FROM active_work WHERE id = ?").run(sourceId);
    }

    if (prNumber !== null && prUrl) {
      const trimmedUrl = prUrl.trim();
      prs = prs.filter(
        (p) =>
          !(
            p.number === prNumber &&
            p.url.trim() === trimmedUrl &&
            (p.repo === repo || !p.repo || !repo)
          )
      );
    }

    db.prepare(`
      UPDATE active_work SET
        sort_order = @sort_order,
        repo = @repo,
        branch = @branch,
        worktree = @worktree,
        notes = @notes,
        pr_number = @pr_number,
        pr_url = @pr_url,
        prs_json = @prs_json,
        links_json = @links_json,
        tags_json = @tags_json,
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: primaryId,
      sort_order: sortOrder,
      repo,
      branch,
      worktree,
      notes: notes || null,
      pr_number: prNumber,
      pr_url: prUrl,
      prs_json: JSON.stringify(prs),
      links_json: JSON.stringify(links),
      tags_json: JSON.stringify(sanitizeTags(mergedTags)),
      updated_at: nowIso(),
    });
  });

  try {
    merge();
    refreshTagVocab();
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
