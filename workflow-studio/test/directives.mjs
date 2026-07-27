import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { parsePromptDirectives } = require("../out/directives.js");

test("parses prompt bindings", () => {
  const result = parsePromptDirectives(`
flowchart TD
%% @prompt Triage -> steps/01-task-picker.md
%% @prompt Confirm -> steps/02-prod-confirm.md
Triage --> Confirm
`);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.bindings, [
    { nodeId: "Triage", relativePath: "steps/01-task-picker.md", line: 3 },
    { nodeId: "Confirm", relativePath: "steps/02-prod-confirm.md", line: 4 },
  ]);
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
