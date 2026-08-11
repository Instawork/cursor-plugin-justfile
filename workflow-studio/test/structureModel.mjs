import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { buildStructure, extractNodeIds } = require("../out/structureModel.js");

function binding(nodeId, relativePath, members) {
  return {
    nodeId,
    memberNodeIds: members || [nodeId],
    relativePath,
    line: 1,
  };
}

test("controller WORKFLOW.md is always first", () => {
  const structure = buildStructure("/tmp/flow.mmd", [], "flowchart TD\nA[A]\n");
  assert.equal(structure[0].kind, "controller");
  assert.equal(structure[0].label, "WORKFLOW.md");
  assert.equal(structure[0].bound, true);
});

test("bound unbound and orphan kinds", () => {
  const bindings = [
    binding("A", "steps/A.md"),
    binding("Orphan", "steps/Orphan.md"),
  ];
  const source = "flowchart TD\nA[A] --> B[B]\n";
  const structure = buildStructure("/tmp/flow.mmd", bindings, source);
  const byId = Object.fromEntries(
    structure.filter((e) => e.nodeId && e.kind !== "file").map((e) => [e.nodeId, e]),
  );
  assert.equal(byId.A.bound, true);
  assert.equal(byId.A.kind, "step");
  assert.equal(byId.B.bound, false);
  assert.equal(byId.B.kind, "unbound");
  assert.equal(byId.Orphan.bound, true);
  assert.match(byId.Orphan.label, /orphan/);
});

test("emits file row then member steps", () => {
  const bindings = [
    binding("FanGet", "steps/02.md", ["FanGet", "Backfill", "OpenSearch"]),
  ];
  const source =
    "flowchart TD\nFanGet[2] --> Backfill[2a]\nOpenSearch[2b]\nOther[x]\n";
  const structure = buildStructure("/tmp/flow.mmd", bindings, source);
  const file = structure.find((e) => e.kind === "file");
  assert.ok(file);
  assert.equal(file.relativePath, "steps/02.md");
  assert.equal(file.fileKey, "steps/02.md");
  const members = structure.filter((e) => e.kind === "step" && e.fileKey === "steps/02.md");
  assert.deepEqual(
    members.map((m) => m.nodeId),
    ["FanGet", "Backfill", "OpenSearch"],
  );
  assert.ok(structure.some((e) => e.nodeId === "Other" && e.kind === "unbound"));
});

test("skips reserved mermaid ids", () => {
  const ids = extractNodeIds("flowchart TD\nsubgraph X\nA[A]\nend\n");
  assert.ok(!ids.includes("flowchart"));
  assert.ok(!ids.includes("subgraph"));
  assert.ok(!ids.includes("end"));
  assert.ok(ids.includes("A"));
});

test("duplicate node shapes yield one rail entry", () => {
  const source = "flowchart TD\nA[A] --> B[B]\nA --> C[C]\n";
  const structure = buildStructure("/tmp/x.mmd", [], source);
  const aCount = structure.filter((e) => e.nodeId === "A").length;
  assert.equal(aCount, 1);
});

test("comment lines are not parsed as nodes", () => {
  const source =
    "%% Source of truth for agents: fix/WORKFLOW.md (not this graph)\nflowchart TD\nA[A]\n";
  const ids = extractNodeIds(source);
  assert.deepEqual(ids, ["A"]);
});

test("prompt directives do not leak into node ids", () => {
  const source = "%% @prompt A -> steps/a.md\nflowchart TD\nA[A]\n";
  assert.deepEqual(extractNodeIds(source), ["A"]);
});

test("subgraph container ids are not steps", () => {
  const source = 'flowchart TD\nsubgraph A["A · Claim"]\ndirection TB\nStart[Start]\nend\n';
  const ids = extractNodeIds(source);
  assert.ok(!ids.includes("A"));
  assert.ok(ids.includes("Start"));
});

test("anonymous subgraph declaration is skipped", () => {
  const ids = extractNodeIds('flowchart TD\nsubgraph "Phase one"\nA[A]\nend\n');
  assert.deepEqual(ids, ["A"]);
});

test("unclosed bracket does not swallow later lines", () => {
  const ids = extractNodeIds("flowchart TD\nA[unclosed\nB[B]\nC[C]\n");
  assert.ok(ids.includes("B"));
  assert.ok(ids.includes("C"));
});
