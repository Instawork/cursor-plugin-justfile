import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  numberedPromptKey,
  numberedLabelKey,
  extractNumberedNodes,
  planAutomaticBindings,
} = require("../out/autoBind.js");

test("numberedPromptKey reads leading step number and optional letter", () => {
  assert.equal(numberedPromptKey("steps/01-pull-asana.md"), "1");
  assert.equal(numberedPromptKey("steps/09-c-re-review.md"), "9-c");
  assert.equal(numberedPromptKey("steps/notebook.md"), undefined);
});

test("numberedLabelKey reads the step token from a node label", () => {
  assert.equal(numberedLabelKey("1 Triage Asana Backlog"), "1");
  assert.equal(numberedLabelKey("4-a Research codebase"), "4-a");
  assert.equal(numberedLabelKey("6-a find-n-plus-one"), "6-a");
  assert.equal(numberedLabelKey("Acquire entity lock"), undefined);
});

test("extractNumberedNodes ignores comments and subgraphs", () => {
  const source = [
    "%% @prompt X -> steps/01-x.md",
    "flowchart TD",
    'subgraph A["A Claim"]',
    'Triage["1 Triage Asana Backlog"]',
    'Confirm["2 Prod confirm"]',
    "end",
  ].join("\n");
  const nodes = extractNumberedNodes(source);
  assert.deepEqual(
    nodes.map((n) => `${n.nodeId}:${n.stepKey}`),
    ["Triage:1", "Confirm:2"],
  );
});

test("ready plan when every prompt maps to exactly one node", () => {
  const source = [
    "flowchart TD",
    'Pull["1 Pull Asana"]',
    'Datadog["2 Pull Datadog"]',
    'Sync["3 Build and sync"]',
    'Verify["4 Verify"]',
  ].join("\n");
  const plan = planAutomaticBindings(source, [
    "steps/01-pull-asana.md",
    "steps/02-pull-datadog.md",
    "steps/03-build-and-sync.md",
    "steps/04-verify.md",
  ]);
  assert.equal(plan.status, "ready");
  assert.deepEqual(
    plan.bindings.map((b) => `${b.nodeId}->${b.relativePath}`),
    [
      "Pull->steps/01-pull-asana.md",
      "Datadog->steps/02-pull-datadog.md",
      "Sync->steps/03-build-and-sync.md",
      "Verify->steps/04-verify.md",
    ],
  );
});

test("incomplete plan writes nothing when a step is ambiguous", () => {
  const source = [
    "flowchart TD",
    'OpenSearch["2 open search"]',
    'FanGet["2 fan-out get"]',
  ].join("\n");
  const plan = planAutomaticBindings(source, ["steps/02-pull-datadog.md"]);
  assert.equal(plan.status, "incomplete");
  assert.equal(plan.bindings.length, 0);
  assert.equal(plan.diagnostics.length, 1);
  assert.match(plan.diagnostics[0], /ambiguous/);
});

test("substep labels like 2b do not match a top-level step 2 prompt", () => {
  const source = [
    "flowchart TD",
    'OpenSearch["2b open search"]',
    'FanGet["2c fan-out get"]',
  ].join("\n");
  const plan = planAutomaticBindings(source, ["steps/02-pull-datadog.md"]);
  assert.equal(plan.status, "incomplete");
  assert.match(plan.diagnostics.join(" "), /no node label starts with step 2/);
});

test("incomplete plan when a prompt has no matching node", () => {
  const source = ["flowchart TD", 'Pull["1 Pull Asana"]'].join("\n");
  const plan = planAutomaticBindings(source, [
    "steps/01-pull-asana.md",
    "steps/02-pull-datadog.md",
  ]);
  assert.equal(plan.status, "incomplete");
  assert.match(plan.diagnostics.join(" "), /no node label starts with step 2/);
});

test("existing directives are never overwritten", () => {
  const source = [
    "%% @prompt Pull -> steps/01-pull-asana.md",
    "flowchart TD",
    'Pull["1 Pull Asana"]',
  ].join("\n");
  const plan = planAutomaticBindings(source, ["steps/01-pull-asana.md"]);
  assert.equal(plan.status, "existing");
  assert.equal(plan.bindings.length, 0);
});

test("no-prompts status when there are no numbered step files", () => {
  const plan = planAutomaticBindings("flowchart TD\nA[A]\n", ["steps/readme.md"]);
  assert.equal(plan.status, "no-prompts");
});

test("duplicate prompt files for one step are reported as ambiguous", () => {
  const source = ["flowchart TD", 'Pull["1 Pull"]'].join("\n");
  const plan = planAutomaticBindings(source, [
    "steps/01-pull-asana.md",
    "steps/01-pull-again.md",
  ]);
  assert.equal(plan.status, "incomplete");
  assert.match(plan.diagnostics.join(" "), /multiple prompt files/);
});
