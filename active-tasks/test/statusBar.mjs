#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "module";
import { join } from "path";

const require = createRequire(
  new URL("../package.json", import.meta.url)
);
const { activeTasksStatusBarText } = require(join(import.meta.dirname, "../out/payload.js"));

function payload(todos, extra) {
  return {
    activeTasks: { todos },
    generatedAt: "2026-01-01T00:00:00Z",
    discovery: {},
    loadError: null,
    notice: null,
    ...extra,
  };
}

test("status bar counts open rows only", () => {
  const text = activeTasksStatusBarText(
    payload([{ id: "1", done: false }, { id: "2", done: true }])
  );
  assert.equal(text, "$(checklist) Tasks 1");
});

test("status bar shows a dash with no rows", () => {
  assert.equal(activeTasksStatusBarText(payload([])), "$(checklist) Tasks —");
});

test("status bar surfaces load errors", () => {
  assert.equal(
    activeTasksStatusBarText(payload([], { loadError: "db gone" })),
    "$(error) Tasks error"
  );
  assert.equal(
    activeTasksStatusBarText(payload([], { notice: { level: "error" } })),
    "$(error) Tasks error"
  );
});
