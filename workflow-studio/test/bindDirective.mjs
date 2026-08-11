import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  insertPromptDirective,
  starterWorkflow,
  defaultPromptPath,
} = require("../out/bindDirective.js");
const { parsePromptDirectives } = require("../out/directives.js");
const { extractNodeIds } = require("../out/structureModel.js");

test("defaultPromptPath slugifies and nests under steps/", () => {
  assert.equal(defaultPromptPath("Triage"), "steps/Triage.md");
  assert.equal(defaultPromptPath("My Step"), "steps/My-Step.md");
  assert.equal(defaultPromptPath("  "), "steps/step.md");
});

test("inserts after last existing prompt directive", () => {
  const source = "%% @prompt A -> steps/A.md\nflowchart TD\nA --> B\n";
  const result = insertPromptDirective(source, "B", "steps/B.md");
  assert.equal(result.ok, true);
  assert.match(result.text, /%% @prompt A -> steps\/A\.md\n%% @prompt B -> steps\/B\.md\nflowchart TD/);
  assert.equal(result.line, 2);
});

test("inserts before flowchart header when no prompts", () => {
  const source = "flowchart TD\nA --> B\n";
  const result = insertPromptDirective(source, "A", "steps/A.md");
  assert.equal(result.ok, true);
  const lines = result.text.split("\n");
  assert.equal(lines[0], "%% @prompt A -> steps/A.md");
  assert.equal(lines[1], "flowchart TD");
});

test("inserts before graph LR header", () => {
  const source = "graph LR\nX --> Y\n";
  const result = insertPromptDirective(source, "X", "steps/X.md");
  assert.equal(result.ok, true);
  assert.match(result.text, /^%% @prompt X -> steps\/X\.md\ngraph LR\n/);
});

test("inserts into empty source with flowchart scaffold", () => {
  const result = insertPromptDirective("", "A", "steps/A.md");
  assert.equal(result.ok, true);
  assert.match(result.text, /flowchart TD/);
  assert.match(result.text, /%% @prompt A -> steps\/A\.md/);
});

test("rejects duplicate nodeId including multi-member lists", () => {
  const source = "%% @prompt FanGet, Backfill -> steps/02.md\nflowchart TD\n";
  const result = insertPromptDirective(source, "Backfill", "steps/other.md");
  assert.equal(result.ok, false);
  assert.match(result.reason, /duplicate/);
});

test("starterWorkflow has three nodes and matching directives", () => {
  const text = starterWorkflow();
  const parsed = parsePromptDirectives(text);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.bindings.length, 3);
  const ids = extractNodeIds(text);
  assert.deepEqual(ids.sort(), ["Confirm", "Done", "Triage"].sort());
  for (const b of parsed.bindings) {
    assert.ok(ids.includes(b.nodeId));
  }
});
