import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { PromptSession } = require("../out/promptStore.js");
const { MAX_PROMPT_BYTES } = require("../out/pathSafety.js");

function noopWatcher() {
  return { dispose() {} };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ws-prompt-"));
  await mkdir(join(root, "steps"), { recursive: true });
  const diagram = join(root, "flow.mmd");
  await writeFile(diagram, "flowchart TD\n", "utf8");
  const promptPath = join(root, "steps", "A.md");
  await writeFile(promptPath, "# hello\n", "utf8");
  return { root, diagram, promptPath };
}

function session(statuses, conflicts) {
  return new PromptSession(
    (s) => statuses.push(s),
    (c) => conflicts.push(c),
    () => {},
    20,
    noopWatcher,
  );
}

test("load existing file returns content and saved", async () => {
  const { root, diagram } = await fixture();
  const statuses = [];
  const conflicts = [];
  const s = session(statuses, conflicts);
  const result = await s.load(diagram, "A", "steps/A.md", [root]);
  assert.equal(result.ok, true);
  assert.equal(result.content, "# hello\n");
  assert.equal(s.getStatus(), "saved");
  await s.dispose();
});

test("load missing file returns ok false", async () => {
  const { root, diagram } = await fixture();
  const s = session([], []);
  const result = await s.load(diagram, "A", "steps/missing.md", [root]);
  assert.equal(result.ok, false);
  assert.match(result.message, /Missing prompt file/);
  await s.dispose();
});

test("noteEdit dirty then flush writes disk", async () => {
  const { root, diagram, promptPath } = await fixture();
  const statuses = [];
  const s = session(statuses, []);
  await s.load(diagram, "A", "steps/A.md", [root]);
  s.noteEdit("# edited\n");
  assert.equal(s.getStatus(), "editing");
  await s.flush();
  assert.equal(s.getStatus(), "saved");
  assert.equal(await readFile(promptPath, "utf8"), "# edited\n");
  await s.dispose();
});

test("force flush clears debounce", async () => {
  const { root, diagram, promptPath } = await fixture();
  const s = session([], []);
  await s.load(diagram, "A", "steps/A.md", [root]);
  s.noteEdit("# fast\n");
  await s.flush();
  assert.equal(await readFile(promptPath, "utf8"), "# fast\n");
  await s.dispose();
});

test("resolveConflict keep overwrites disk; load replaces buffer", async () => {
  const { root, diagram, promptPath } = await fixture();
  const conflicts = [];
  const s = session([], conflicts);
  await s.load(diagram, "A", "steps/A.md", [root]);
  s.noteEdit("# mine\n");
  s.forceConflictForTest("# disk\n");
  assert.equal(s.getStatus(), "conflict");
  const kept = await s.resolveConflict("keep");
  assert.equal(kept, "# mine\n");
  assert.equal(await readFile(promptPath, "utf8"), "# mine\n");

  s.noteEdit("# mine2\n");
  s.forceConflictForTest("# disk2\n");
  const loaded = await s.resolveConflict("load");
  assert.equal(loaded, "# disk2\n");
  assert.equal(s.getStatus(), "saved");
  await s.dispose();
});

test("oversized load refused", async () => {
  const { root, diagram } = await fixture();
  const big = join(root, "steps", "big.md");
  await writeFile(big, "x".repeat(MAX_PROMPT_BYTES + 1), "utf8");
  const s = session([], []);
  const result = await s.load(diagram, "A", "steps/big.md", [root]);
  assert.equal(result.ok, false);
  assert.match(result.message, /exceeds/);
  await s.dispose();
});

test("clearEditor flushes then clears paths", async () => {
  const { root, diagram, promptPath } = await fixture();
  const s = session([], []);
  await s.load(diagram, "A", "steps/A.md", [root]);
  s.noteEdit("# bye\n");
  await s.clearEditor();
  assert.equal(s.getAbsolutePath(), undefined);
  assert.equal(s.getStatus(), "idle");
  assert.equal(await readFile(promptPath, "utf8"), "# bye\n");
  await s.dispose();
});
