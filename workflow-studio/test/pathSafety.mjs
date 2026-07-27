import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { resolvePromptTarget, MAX_PROMPT_BYTES } = require("../out/pathSafety.js");

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "workflow-studio-"));
  const diagram = join(root, "flow.mmd");
  await writeFile(diagram, "flowchart TD\n", "utf8");
  await mkdir(join(root, "steps"), { recursive: true });
  await writeFile(join(root, "steps", "ok.md"), "# ok\n", "utf8");
  return { root, diagram };
}

test("allows workspace-relative prompt files", async () => {
  const { root, diagram } = await workspace();
  const result = await resolvePromptTarget(diagram, "steps/ok.md", [root]);
  assert.equal(result.safe, true);
  assert.equal(result.exists, true);
  assert.equal(await realpath(result.targetPath), await realpath(join(root, "steps", "ok.md")));
});

test("rejects absolute, escape, and secret paths", async () => {
  const { root, diagram } = await workspace();
  const abs = await resolvePromptTarget(diagram, "/tmp/x.md", [root]);
  assert.equal(abs.safe, false);

  const escape = await resolvePromptTarget(diagram, "../outside.md", [root]);
  assert.equal(escape.safe, false);

  const envFile = await resolvePromptTarget(diagram, ".env", [root]);
  assert.equal(envFile.safe, false);

  const secret = await resolvePromptTarget(diagram, "steps/my-secrets.md", [root]);
  assert.equal(secret.safe, false);

  const localPy = await resolvePromptTarget(diagram, "src/config/local.py", [root]);
  assert.equal(localPy.safe, false);
});

test("rejects symlink escape outside workspace", async () => {
  const { root, diagram } = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "workflow-studio-out-"));
  const outsideFile = join(outside, "leak.md");
  await writeFile(outsideFile, "nope\n", "utf8");
  await symlink(outsideFile, join(root, "steps", "leak.md"));
  const result = await resolvePromptTarget(diagram, "steps/leak.md", [root]);
  assert.equal(result.safe, false);
  assert.match(result.reason || "", /symbolic link/i);
});

test("reports missing file when directory exists", async () => {
  const { root, diagram } = await workspace();
  const result = await resolvePromptTarget(diagram, "steps/missing.md", [root]);
  assert.equal(result.safe, true);
  assert.equal(result.exists, false);
});

test("exposes size cap constant", () => {
  assert.equal(MAX_PROMPT_BYTES, 2 * 1024 * 1024);
});
