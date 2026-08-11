import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { planPathFromUrl, planLinkFor } = require(join(root, "out/planLink.js"));

const plans = join(homedir(), ".cursor", "plans");

test("accepts a tilde path to a plan file", () => {
  assert.equal(
    planPathFromUrl("~/.cursor/plans/thing.plan.md"),
    join(plans, "thing.plan.md")
  );
});

test("accepts an absolute path and a file url", () => {
  const abs = join(plans, "thing.plan.md");
  assert.equal(planPathFromUrl(abs), abs);
  assert.equal(planPathFromUrl(`file://${abs}`), abs);
});

test("rejects http links and non-plan files", () => {
  assert.equal(planPathFromUrl("https://example.com/x.plan.md"), null);
  assert.equal(planPathFromUrl(join(plans, "notes.md")), null);
});

test("rejects traversal out of the plans directory", () => {
  // The panel turns this into an open-file action, so a link that escapes the
  // plans directory must not resolve.
  assert.equal(planPathFromUrl("~/.cursor/plans/../../.ssh/id_rsa.plan.md"), null);
  assert.equal(planPathFromUrl("~/code/secret.plan.md"), null);
});

test("planLinkFor returns the first plan link and ignores the rest", () => {
  assert.equal(
    planLinkFor([
      { label: "pr", url: "https://github.com/a/b/pull/1" },
      { label: "plan", url: "~/.cursor/plans/a.plan.md" },
      { label: "plan2", url: "~/.cursor/plans/b.plan.md" },
    ]),
    join(plans, "a.plan.md")
  );
  assert.equal(planLinkFor([]), null);
  assert.equal(planLinkFor(undefined), null);
});
