import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  isUnderCursorDir,
  sortWorkflowPaths,
  workflowLabel,
  workflowSortKey,
  CURSOR_WORKFLOW_GLOBS,
} = require("../out/discoverWorkflows.js");

test("isUnderCursorDir only matches workspace-root .cursor", () => {
  const roots = ["/repo"];
  assert.equal(isUnderCursorDir("/repo/.cursor/sre-orchestrator/fix/a.mmd", roots), true);
  assert.equal(isUnderCursorDir("/repo/.cursor/skills/pack/x.mmd", roots), true);
  assert.equal(isUnderCursorDir("/repo/apps/web/.cursor/flows/a.mmd", roots), false);
  assert.equal(isUnderCursorDir("/repo/docs/diagram.mmd", roots), false);
  assert.equal(isUnderCursorDir("/repo/cursorignore/a.mmd", roots), false);
});

test("sortWorkflowPaths prefers .cursor paths", () => {
  const roots = ["/repo"];
  const sorted = sortWorkflowPaths(
    ["/repo/other.mmd", "/repo/.cursor/b/z.mmd", "/repo/.cursor/a/x.mmd"],
    roots,
  );
  assert.equal(sorted[0], "/repo/.cursor/a/x.mmd");
  assert.equal(sorted[1], "/repo/.cursor/b/z.mmd");
  assert.equal(sorted[2], "/repo/other.mmd");
  assert.ok(
    workflowSortKey("/repo/.cursor/a.mmd", roots) < workflowSortKey("/repo/a.mmd", roots),
  );
});

test("workflowLabel is workspace-relative when possible", () => {
  assert.equal(
    workflowLabel("/repo/.cursor/fix/a.mmd", ["/repo"]),
    ".cursor/fix/a.mmd",
  );
  assert.equal(workflowLabel("/elsewhere/a.mmd", ["/repo"]), "a.mmd");
});

test("CURSOR_WORKFLOW_GLOBS is workspace-root .cursor/**/*.mmd", () => {
  assert.deepEqual([...CURSOR_WORKFLOW_GLOBS], [".cursor/**/*.mmd"]);
});
