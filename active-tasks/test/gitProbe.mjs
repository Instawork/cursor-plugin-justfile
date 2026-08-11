import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parsePorcelainStatus, parseWorktreeList } = require(
  join(root, "out/gitProbe.js")
);

test("porcelain status reads branch, divergence, and dirty count", () => {
  const out = [
    "## feature/foo...origin/feature/foo [ahead 2, behind 3]",
    " M src/a.ts",
    "?? src/b.ts",
    "",
  ].join("\n");
  assert.deepEqual(parsePorcelainStatus(out), {
    branch: "feature/foo",
    detached: false,
    ahead: 2,
    behind: 3,
    dirtyCount: 2,
  });
});

test("porcelain status handles a clean detached head", () => {
  const s = parsePorcelainStatus("## HEAD (no branch)\n");
  assert.equal(s.detached, true);
  assert.equal(s.branch, null);
  assert.equal(s.dirtyCount, 0);
});

test("porcelain status does not count the header as a change", () => {
  // The `## ` line is metadata. Counting it made every clean worktree look
  // dirty by exactly one file.
  assert.equal(parsePorcelainStatus("## main...origin/main\n").dirtyCount, 0);
});

test("worktree list marks only the first entry primary and strips refs/heads", () => {
  const out = [
    "worktree /Users/x/code/repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /Users/x/code/repo-fix",
    "HEAD def456",
    "branch refs/heads/fix/thing",
    "",
    "worktree /Users/x/code/repo-detached",
    "HEAD 999aaa",
    "detached",
    "",
  ].join("\n");
  const entries = parseWorktreeList(out);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].primary, true);
  assert.equal(entries[0].branch, "main");
  assert.equal(entries[1].primary, false);
  assert.equal(entries[1].branch, "fix/thing");
  assert.equal(entries[2].detached, true);
  assert.equal(entries[2].branch, null);
});
