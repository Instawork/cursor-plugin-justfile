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
} = require(join(root, "out/statusKeyUtil.js"));

test("inferStatusKeyFromLabel maps review and blocked", () => {
  assert.equal(inferStatusKeyFromLabel("review (Duncan)"), "review");
  assert.equal(inferStatusKeyFromLabel("CI red / blocked"), "blocked");
  assert.equal(inferStatusKeyFromLabel("ready to merge"), "ready");
});

test("urgencyFromTodo respects priority and status_key", () => {
  assert.equal(
    urgencyFromTodo({ status_key: "blocked", priority: 1 }),
    "high"
  );
  assert.equal(
    urgencyFromTodo({ status_key: "ready", priority: 3 }),
    "high"
  );
  assert.equal(clampPriority(9), 3);
});
