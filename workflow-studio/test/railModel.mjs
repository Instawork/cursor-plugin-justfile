import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  groupRail,
  nextIndex,
  prevIndex,
  nextUnbound,
  indexOfNode,
  memberNodeIdsForSelection,
} = require("../out/railModel.js");

const structure = [
  { kind: "controller", label: "WORKFLOW.md", relativePath: "WORKFLOW.md", bound: true },
  {
    kind: "file",
    label: "steps/A.md",
    relativePath: "steps/A.md",
    nodeId: "A",
    fileKey: "steps/A.md",
    bound: true,
  },
  {
    kind: "step",
    label: "A",
    nodeId: "A",
    relativePath: "steps/A.md",
    fileKey: "steps/A.md",
    bound: true,
  },
  {
    kind: "step",
    label: "A2",
    nodeId: "A2",
    relativePath: "steps/A.md",
    fileKey: "steps/A.md",
    bound: true,
  },
  { kind: "unbound", label: "B", nodeId: "B", bound: false },
  { kind: "unbound", label: "C", nodeId: "C", bound: false },
];

test("groups Bound Unbound Diagnostics with counts", () => {
  const grouped = groupRail(structure, ["bad line"], "");
  assert.equal(grouped.sections[0].id, "bound");
  assert.equal(grouped.sections[0].count, 4);
  assert.equal(grouped.sections[1].id, "unbound");
  assert.equal(grouped.sections[1].count, 2);
  assert.equal(grouped.sections[2].id, "diagnostics");
  assert.equal(grouped.sections[2].count, 1);
  assert.equal(grouped.flat.length, 6);
});

test("filter is case-insensitive on label and path", () => {
  const grouped = groupRail(structure, [], "steps/a");
  assert.ok(grouped.sections[0].count >= 1);
  assert.ok(grouped.sections[0].entries.some((e) => e.nodeId === "A"));
  assert.equal(grouped.sections[1].count, 0);
});

test("empty filter returns full; no-match empties groups", () => {
  const full = groupRail(structure, [], "  ");
  assert.equal(full.flat.length, 6);
  const none = groupRail(structure, ["diag"], "zzz-nope");
  assert.equal(none.flat.length, 0);
  assert.equal(none.sections[2].count, 0);
});

test("nextIndex and prevIndex clamp", () => {
  assert.equal(nextIndex(0, 3), 1);
  assert.equal(nextIndex(2, 3), 2);
  assert.equal(prevIndex(2, 3), 1);
  assert.equal(prevIndex(0, 3), 0);
  assert.equal(nextIndex(-1, 3), 0);
  assert.equal(nextIndex(0, 0), -1);
});

test("nextUnbound wraps and skips bound", () => {
  assert.equal(nextUnbound(structure, null), "B");
  assert.equal(nextUnbound(structure, "B"), "C");
  assert.equal(nextUnbound(structure, "C"), "B");
  assert.equal(nextUnbound(structure, "A"), "B");
});

test("indexOfNode", () => {
  const flat = groupRail(structure, [], "").flat;
  assert.equal(indexOfNode(flat, "B"), 4);
  assert.equal(indexOfNode(flat, null), -1);
});

test("memberNodeIdsForSelection returns all file members", () => {
  assert.deepEqual(memberNodeIdsForSelection(structure, "A").sort(), ["A", "A2"]);
  assert.deepEqual(memberNodeIdsForSelection(structure, "A2").sort(), ["A", "A2"]);
  assert.deepEqual(memberNodeIdsForSelection(structure, "B"), ["B"]);
  assert.deepEqual(memberNodeIdsForSelection(structure, null), []);
});
