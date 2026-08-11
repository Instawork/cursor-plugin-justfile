import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  inferStatusKeyFromLabel,
  urgencyFromTodo,
  clampPriority,
  normalizeStatusKey,
} = require(join(root, "out/statusKeyUtil.js"));
const {
  archiveReasonForStatusKey,
  doneReasonForStatusKey,
  normalizeDoneReason,
} = require(join(root, "out/taskModel.js"));

test("inferStatusKeyFromLabel maps review and blocked", () => {
  assert.equal(inferStatusKeyFromLabel("review (Duncan)"), "review");
  assert.equal(inferStatusKeyFromLabel("CI red / blocked"), "blocked");
  assert.equal(inferStatusKeyFromLabel("ready to merge"), "backlog");
  assert.equal(inferStatusKeyFromLabel("prioritized"), "prioritized");
});

test("normalizeStatusKey remaps legacy keys to backlog", () => {
  assert.equal(normalizeStatusKey("ready"), "backlog");
  assert.equal(normalizeStatusKey("paused"), "backlog");
  assert.equal(normalizeStatusKey("other"), "backlog");
  assert.equal(normalizeStatusKey("prioritized"), "prioritized");
  assert.equal(normalizeStatusKey("nope"), "backlog");
});

test("terminal status keys are not open buckets; doneReason maps them", () => {
  // normalizeStatusKey must not invent an open "done" column.
  assert.equal(normalizeStatusKey("done"), "backlog");
  assert.equal(normalizeStatusKey("wont_fix"), "backlog");
  assert.equal(doneReasonForStatusKey("done"), "manual");
  assert.equal(doneReasonForStatusKey("wont_fix"), "wont_fix");
  assert.equal(doneReasonForStatusKey("backlog"), null);
  assert.equal(archiveReasonForStatusKey("done"), "manual");
});

test("normalizeDoneReason validates vocab", () => {
  assert.equal(normalizeDoneReason("wont_fix"), "wont_fix");
  assert.equal(normalizeDoneReason("merged"), "merged");
  assert.equal(normalizeDoneReason("typo-reason"), "manual");
  assert.equal(normalizeDoneReason(null), "manual");
});

test("urgencyFromTodo respects priority and status_key (0 = highest)", () => {
  assert.equal(
    urgencyFromTodo({ status_key: "blocked", priority: 2 }),
    "high"
  );
  assert.equal(
    urgencyFromTodo({ status_key: "backlog", priority: 0 }),
    "high"
  );
  assert.equal(
    urgencyFromTodo({ status_key: "backlog", priority: 2 }),
    "low"
  );
  assert.equal(
    urgencyFromTodo({ status_key: "progress", priority: 1 }),
    "high"
  );
  assert.equal(
    urgencyFromTodo({ status_key: "progress", priority: 3 }),
    "medium"
  );
  assert.equal(clampPriority(9), 3);
});
