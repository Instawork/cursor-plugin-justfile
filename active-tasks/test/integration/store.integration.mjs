#!/usr/bin/env node
/**
 * Integration tests: real better-sqlite3 + compiled store (no VS Code host).
 * Run: npm run compile && npm test
 */
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
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
    assert.ok(cols.includes("spec"));
  });
});

test("spec migration backfills plan links and children inherit it", () => {
  withTempDb(({ store }) => {
    const parent = store.insertWorkFromQuickAdd("Parent", "progress").id;
    const child = store.insertWorkFromQuickAdd("Child", "backlog").id;
    assert.ok(parent && child);
    const plan = join(homedir(), ".cursor", "plans", "shared.plan.md");
    store.updateTaskFieldsInDb(parent, {
      links_json: JSON.stringify([{ label: "plan", url: plan }]),
    });
    store.nestTaskUnderInDb(child, parent);
    store.closeActiveTasksDb();
    store.openActiveTasksDb();
    const rows = store.loadTodosFromDb();
    assert.equal(rows.find((row) => row.id === parent)?.spec, plan);
    assert.equal(rows.find((row) => row.id === child)?.spec_effective, plan);
  });
});

test("insert, load, and tag vocab", () => {
  withTempDb(({ store }) => {
    const activeTasksMod = loadActiveTasks();
    const id = store.insertWorkFromQuickAdd("Ship feature", "in progress", "finch").id;
    assert.ok(id);
    store.updateTaskFieldsInDb(id, { tags: ["release", "finch", "release"] });
    const snap = activeTasksMod.loadActiveTasks();
    assert.equal(snap.todos.length, 1);
    assert.deepEqual(snap.todos[0].tags, ["release", "finch"]);
    assert.ok(snap.tagVocab.includes("release"));
    assert.ok(snap.tagVocab.includes("finch"));
  });
});

test("setTaskPinnedInDb moves row to pinned section order", () => {
  withTempDb(({ store }) => {
    const a = store.insertWorkFromQuickAdd("First", "in progress", "finch").id;
    const b = store.insertWorkFromQuickAdd("Second", "in progress", "finch").id;
    assert.ok(a && b);
    assert.ok(store.setTaskPinnedInDb(b, true));
    const rows = store.loadTodosFromDb();
    assert.equal(rows[0].id, b);
    assert.equal(rows[0].pinned, true);
    assert.ok(store.setTaskPinnedInDb(b, false));
    const rows2 = store.loadTodosFromDb();
    assert.equal(rows2[0].pinned, false);
  });
});

test("mergeWorkRowsIntoPrimary nests rows under primary", () => {
  withTempDb(({ store }) => {
    const a = store.insertWorkFromQuickAdd("Initiative A", "open PR", "instawork").id;
    const b = store.insertWorkFromQuickAdd("Initiative B", "review", "finch").id;
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
    assert.equal(rows.length, 2);
    const parent = rows.find((r) => r.id === a);
    const child = rows.find((r) => r.id === b);
    assert.equal(child?.parent_id, a);
    assert.deepEqual(parent?.tags, ["deploy"]);
    assert.deepEqual(child?.tags, ["finch-side"]);
    assert.equal(parent?.pr_number, 100);
  });
});

test("import-toml-if-empty via seedActiveWorkIfEmpty", (t) => {
  const script = join(
    homedir(),
    "code/cursor-contexts/scripts/active_tasks_db.py"
  );
  const { existsSync } = require("fs");
  if (!existsSync(script)) {
    t.skip("canonical active_tasks_db.py not present");
    return;
  }
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
    store.insertWorkFromQuickAdd("Payload row", "blocked", null).id;
    const { loadActiveTasksPayload } = loadPayload();
    const payload = loadActiveTasksPayload({
      repoKey: null,
      branch: null,
      folder: null,
    });
    assert.equal(payload.loadError, null);
    assert.equal(payload.activeTasks.todos.length, 1);
    assert.ok(payload.activeTasks.source?.includes("active-tasks.sqlite"));
    assert.ok(payload.discovery.prStatusByTodoId);
    assert.ok(payload.discovery.gitStatusByTodoId);
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

test("nest and move sibling update parent_id and order", () => {
  withTempDb(({ store }) => {
    store.openActiveTasksDb();
    const a = store.insertWorkFromQuickAdd("Parent", "in progress").id;
    const b = store.insertWorkFromQuickAdd("Child", "ready").id;
    const c = store.insertWorkFromQuickAdd("Sibling", "ready").id;
    assert.ok(a && b && c);
    assert.ok(store.nestTaskUnderInDb(b, a));
    let todos = store.loadTodosFromDb().filter((t) => !t.done);
    const byId = new Map(todos.map((t) => [t.id, t]));
    assert.equal(byId.get(b).parent_id, a);
    const order = todos.map((t) => t.id);
    assert.ok(order.indexOf(b) > order.indexOf(a));
    assert.ok(!store.nestTaskUnderInDb(a, b));
    assert.ok(store.moveTaskSiblingInDb(b, c, true));
    todos = store.loadTodosFromDb().filter((t) => !t.done);
    assert.ok(!todos.find((t) => t.id === b)?.parent_id);
  });
});

test("malformed links_json is rejected instead of silently stored", () => {
  withTempDb(({ store }) => {
    store.openActiveTasksDb();
    const id = store.insertWorkFromQuickAdd("JSON guard", "ready").id;
    assert.throws(
      () => store.updateTaskFieldsInDb(id, { links_json: "{not json" }),
      /links_json/
    );
    assert.throws(
      () => store.updateTaskFieldsInDb(id, { prs_json: '{"a":1}' }),
      /prs_json/
    );
    assert.ok(
      store.updateTaskFieldsInDb(id, {
        links_json: '[{"label":"plan","url":"file:///tmp/x.md"}]',
      })
    );
    const row = store.loadTodosFromDb().find((t) => t.id === id);
    assert.equal(row.links[0].label, "plan");
  });
});

test("priority 0 sorts first and reorder leaves updated_at alone", () => {
  withTempDb(({ store }) => {
    store.openActiveTasksDb();
    const low = store.insertWorkFromQuickAdd("Low", "ready").id;
    const high = store.insertWorkFromQuickAdd("High", "ready").id;
    store.updateTaskFieldsInDb(high, { priority: 0 });
    store.updateTaskFieldsInDb(low, { priority: 3 });

    let open = store.loadTodosFromDb().filter((t) => !t.done);
    assert.equal(open[0].id, high, "priority 0 must sort ahead of priority 3");

    const before = new Map(open.map((t) => [t.id, t.updated_at]));
    assert.ok(store.reorderTasksInDb([low, high]));
    open = store.loadTodosFromDb().filter((t) => !t.done);
    for (const t of open) {
      assert.equal(
        t.updated_at,
        before.get(t.id),
        "reordering must not rewrite the staleness signal"
      );
    }
  });
});

test("deleting a row clears blockers pointing at it", () => {
  withTempDb(({ store }) => {
    store.openActiveTasksDb();
    const blocker = store.insertWorkFromQuickAdd("Blocker", "progress").id;
    const waiter = store.insertWorkFromQuickAdd("Waiter", "blocked").id;
    store.updateTaskFieldsInDb(waiter, { blocked_by_id: blocker });
    assert.ok(store.deleteTaskFromDb(blocker));
    const row = store.loadTodosFromDb().find((t) => t.id === waiter);
    assert.equal(row.blocked_by_id ?? null, null);
  });
});
