import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { tagAccentFor } = require(join(root, "out/tagsUtil.js"));

test("tagAccentFor is stable and uses overrides", () => {
  assert.equal(tagAccentFor("sentry"), "#6C5FC7");
  assert.equal(tagAccentFor("Sentry"), "#6C5FC7");
  assert.equal(tagAccentFor("finch"), "#0d9488");
  assert.equal(tagAccentFor("custom-tag"), tagAccentFor("custom-tag"));
  assert.notEqual(tagAccentFor("alpha"), tagAccentFor("beta"));
});
