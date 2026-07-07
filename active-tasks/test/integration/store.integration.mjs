#!/usr/bin/env node
/**
 * Integration tests: real better-sqlite3 + compiled store (no VS Code host).
 * Run: npm run compile && npm test
 */
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const require = createRequire(
  new URL("../../package.json", import.meta.url)
);
const root = join(import.meta.dirname, "../..");

function loadStore() {
  return require(join(root, "out/activeTasksStore.js"));
}

function loadActiveTasks() {
  return require(join(root, "out/activeTasks.js"));
}

function loadPayload() {
  return require(join(root, "out/payload.js"));
}

function loadConsolidation() {
  return require(join(root, "out/workConsolidation.js"));
}

function loadTagsUtil() {
  return require(join(root, "out/tagsUtil.js"));
}

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "active-tasks-it-"));
  const dbPath = join(dir, "active-tasks.sqlite");
  const prev = process.env.ACTIVE_TASKS_DB_PATH;
  const prevSkip = process.env.ACTIVE_TASKS_SKIP_LEGACY_IMPORT;
  process.env.ACTIVE_TASKS_DB_PATH = dbPath;
  process.env.ACTIVE_TASKS_SKIP_LEGACY_IMPORT = "1";
  const store = loadStore();
  store.closeActiveTasksDb();
  try {
    return fn({ dir, dbPath, store });
  } finally {
    store.closeActiveTasksDb();
    if (prev === undefined) {
      delete process.env.ACTIVE_TASKS_DB_PATH;
    } else {
      process.env.ACTIVE_TASKS_DB_PATH = prev;
    }
    if (prevSkip === undefined) {
      delete process.env.ACTIVE_TASKS_SKIP_LEGACY_IMPORT;
    } else {
      process.env.ACTIVE_TASKS_SKIP_LEGACY_IMPORT = prevSkip;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("schema creates active_work and migrates tags_json", () => {
  withTempDb(({ dbPath, store }) => {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE active_work (
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
    `);
    raw.close();

    store.openActiveTasksDb();
    const cols = store
      .openActiveTasksDb()
      .prepare("PRAGMA table_info(active_work)")
      .all()
      .map((r) => r.name);
    assert.ok(cols.includes("tags_json"));
  });
});

test("insert, load, and tag vocab", () => {
  withTempDb(({ store }) => {
    const activeTasksMod = loadActiveTasks();
    const id = store.insertWorkFromQuickAdd("Ship feature", "in progress", "finch");
    assert.ok(id);
    store.updateTaskFieldsInDb(id, { tags: ["release", "finch", "release"] });
    const snap = activeTasksMod.loadActiveTasks();
    assert.equal(snap.todos.length, 1);
    assert.deepEqual(snap.todos[0].tags, ["release", "finch"]);
    assert.ok(snap.tagVocab.includes("release"));
    assert.ok(snap.tagVocab.includes("finch"));
  });
});

test("mergeWorkRowsIntoPrimary merges tags and extra PRs", () => {
  withTempDb(({ store }) => {
    const a = store.insertWorkFromQuickAdd("Initiative A", "open PR", "instawork");
    const b = store.insertWorkFromQuickAdd("Initiative B", "review", "finch");
    assert.ok(a && b);
    store.updateTaskFieldsInDb(a, {
      tags: ["deploy"],
      pr_number: 100,
      pr_url: "https://github.com/Instawork/instawork/pull/100",
    });
    store.updateTaskFieldsInDb(b, { tags: ["finch-side"] });
    assert.ok(store.mergeWorkRowsIntoPrimary(a, [b]));
    store.closeActiveTasksDb();
    const rows = store.loadTodosFromDb();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].tags?.sort(), ["deploy", "finch-side"].sort());
    assert.equal(rows[0].pr_number, 100);
  });
});

test("import-toml-if-empty via seedActiveWorkIfEmpty", () => {
  withTempDb(({ dir, store }) => {
    delete process.env.ACTIVE_TASKS_SKIP_LEGACY_IMPORT;
    const toml = join(dir, "active-tasks.toml");
    writeFileSync(
      toml,
      `schema_version = 1

[[active_work]]
title = "Imported row"
status = "in progress"
repo = "finch"
`,
      "utf8"
    );
    const script = join(root, "bundled/hooks/active_tasks_db.py");
    const prevPy = process.env.ACTIVE_TASKS_PYTHON || "python3.11";
    const { execFileSync } = require("child_process");
    execFileSync(prevPy, [script, "import-toml-if-empty", toml], {
      env: { ...process.env, ACTIVE_TASKS_DB_PATH: process.env.ACTIVE_TASKS_DB_PATH },
      stdio: "pipe",
    });
    store.closeActiveTasksDb();
    const n = store.loadTodosFromDb().length;
    assert.equal(n, 1);
    const todos = store.loadTodosFromDb();
    assert.equal(todos[0].title, "Imported row");
    assert.equal(todos[0].repo, "finch");
  });
});

test("loadActiveTasksPayload connects to temp db", () => {
  withTempDb(({ store }) => {
    store.insertWorkFromQuickAdd("Payload row", "blocked", null);
    const { loadActiveTasksPayload } = loadPayload();
    const payload = loadActiveTasksPayload({
      repoKey: null,
      branch: null,
      folder: null,
    });
    assert.equal(payload.loadError, null);
    assert.equal(payload.activeTasks.todos.length, 1);
    assert.ok(payload.activeTasks.source?.includes("active-tasks.sqlite"));
    assert.ok(payload.discovery.structuralMergeCandidates);
  });
});

test("structural merge suggestions ignore title-only overlap", () => {
  const { suggestStructuralMerges } = loadConsolidation();
  const todos = [
    {
      id: "1",
      label: "a",
      done: false,
      title: "Twilio SMS impersonation",
      status: "review",
    },
    {
      id: "2",
      label: "b",
      done: false,
      title: "Twilio SMS tool",
      status: "in progress",
    },
  ];
  assert.equal(suggestStructuralMerges(todos).length, 0);
  todos[0].branch = "narek/shared-branch";
  todos[1].branch = "narek/shared-branch";
  assert.equal(suggestStructuralMerges(todos).length, 1);
});

test("sanitizeTags normalizes and dedupes", () => {
  const { sanitizeTags } = loadTagsUtil();
  assert.deepEqual(sanitizeTags(["  Foo ", "foo", "Bar"]), ["Foo", "Bar"]);
});
