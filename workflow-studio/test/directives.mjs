import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { parsePromptDirectives, findBindingForNode } = require("../out/directives.js");

test("parses prompt bindings", () => {
  const result = parsePromptDirectives(`
flowchart TD
%% @prompt Triage -> steps/01-task-picker.md
%% @prompt Confirm -> steps/02-prod-confirm.md
Triage --> Confirm
`);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.bindings, [
    {
      nodeId: "Triage",
      memberNodeIds: ["Triage"],
      relativePath: "steps/01-task-picker.md",
      line: 3,
    },
    {
      nodeId: "Confirm",
      memberNodeIds: ["Confirm"],
      relativePath: "steps/02-prod-confirm.md",
      line: 4,
    },
  ]);
});

test("parses multi-id member list with first id as anchor", () => {
  const result = parsePromptDirectives(
    "%% @prompt FanGet, Backfill, OpenSearch, Union -> steps/02-pull-datadog.md\n",
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0].nodeId, "FanGet");
  assert.deepEqual(result.bindings[0].memberNodeIds, [
    "FanGet",
    "Backfill",
    "OpenSearch",
    "Union",
  ]);
});

test("findBindingForNode matches members", () => {
  const { bindings } = parsePromptDirectives(
    "%% @prompt FanGet, Backfill -> steps/02.md\n",
  );
  assert.equal(findBindingForNode(bindings, "Backfill")?.nodeId, "FanGet");
  assert.equal(findBindingForNode(bindings, "Missing"), undefined);
});

test("reports malformed and duplicate directives", () => {
  const result = parsePromptDirectives(`%% @prompt Broken
%% @prompt Same -> a.md
%% @prompt Same -> b.md
`);
  assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0].relativePath, "a.md");
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /expected %% @prompt/);
  assert.match(result.errors[1], /duplicate prompt binding for Same/);
});

test("rejects member claimed by two files", () => {
  const result = parsePromptDirectives(`%% @prompt A, Shared -> a.md
%% @prompt B, Shared -> b.md
`);
  assert.equal(result.bindings.length, 1);
  assert.match(result.errors[0], /duplicate prompt binding for Shared/);
});

test("rejects invalid member ids", () => {
  const result = parsePromptDirectives("%% @prompt A, 1bad -> steps/a.md\n");
  assert.equal(result.bindings.length, 0);
  assert.match(result.errors[0], /invalid node id/);
});

test("empty source yields no bindings", () => {
  const result = parsePromptDirectives("");
  assert.equal(result.bindings.length, 0);
  assert.equal(result.errors.length, 0);
});

test("mermaid without directives is fine", () => {
  const result = parsePromptDirectives("flowchart TD\nA --> B\n");
  assert.equal(result.bindings.length, 0);
  assert.equal(result.errors.length, 0);
});

test("parses CRLF lines", () => {
  const result = parsePromptDirectives("flowchart TD\r\n%% @prompt Step_1 -> steps/Step_1.md\r\n");
  assert.equal(result.errors.length, 0);
  assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0].nodeId, "Step_1");
});

test("rejects whitespace around arrow (current regex)", () => {
  const result = parsePromptDirectives("%% @prompt A -> steps/a.md\n%% @prompt B  ->  steps/b.md\n");
  assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0].nodeId, "A");
  assert.equal(result.errors.length, 1);
});

test("allows underscores and digits in node ids", () => {
  const result = parsePromptDirectives("%% @prompt Step_2a -> steps/x.md\n");
  assert.equal(result.errors.length, 0);
  assert.equal(result.bindings[0].nodeId, "Step_2a");
});
