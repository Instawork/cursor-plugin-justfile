import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parentIdMap, isUnderAncestor, insertAfterSubtreeInOrder } = require(
  join(root, "out/taskNestUtil.js")
);

test("isUnderAncestor walks a normal parent chain", () => {
  const map = parentIdMap([
    { id: "child", parent_id: "mid" },
    { id: "mid", parent_id: "root" },
    { id: "root", parent_id: null },
  ]);
  assert.equal(isUnderAncestor(map, "child", "root"), true);
  assert.equal(isUnderAncestor(map, "root", "child"), false);
});

test("isUnderAncestor terminates on a pre-existing cycle", () => {
  // The table can contain a cycle written by an external process. Without a
  // visited set the miss case below never returns and hangs the extension host.
  const map = parentIdMap([
    { id: "a", parent_id: "b" },
    { id: "b", parent_id: "a" },
    { id: "loner", parent_id: null },
  ]);
  assert.equal(isUnderAncestor(map, "a", "b"), true);
  assert.equal(isUnderAncestor(map, "a", "loner"), false);
});

test("insertAfterSubtreeInOrder places a child after the parent subtree", () => {
  const map = parentIdMap([
    { id: "p", parent_id: null },
    { id: "p-kid", parent_id: "p" },
    { id: "other", parent_id: null },
    { id: "moved", parent_id: "p" },
  ]);
  const next = insertAfterSubtreeInOrder(
    ["p", "p-kid", "other", "moved"],
    "p",
    "moved",
    map
  );
  assert.deepEqual(next, ["p", "p-kid", "moved", "other"]);
});
