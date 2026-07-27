#!/usr/bin/env node
/**
 * Smoke: channel cost math matches Cursor Auto Cost docs.
 * Run: npm run compile && node --test test/modelPricing.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "module";
import { join } from "path";

const require = createRequire(new URL("../package.json", import.meta.url));
const root = join(import.meta.dirname, "..");
const {
  clearModelRatesCache,
  costFromChannels,
  modelChannelRates,
} = require(join(root, "out/modelPricing.js"));

test("Auto Cost channels match Cursor docs", () => {
  clearModelRatesCache();
  const ch = modelChannelRates("default");
  assert.equal(ch.input, 1.25);
  assert.equal(ch.cacheWrite, 1.25);
  assert.equal(ch.cacheRead, 0.25);
  assert.equal(ch.output, 6.0);
});

test("Sonnet uses API channel rates", () => {
  clearModelRatesCache();
  const ch = modelChannelRates("claude-4-5-sonnet-medium-thinking");
  assert.equal(ch.input, 3.0);
  assert.equal(ch.cacheWrite, 3.75);
  assert.equal(ch.cacheRead, 0.3);
  assert.equal(ch.output, 15.0);
});

test("Composer 2.5 before generic composer", () => {
  clearModelRatesCache();
  const ch = modelChannelRates("composer-2.5");
  assert.equal(ch.input, 0.5);
  assert.equal(ch.cacheRead, 0.2);
  assert.equal(ch.output, 2.5);
});

test("costFromChannels weights cache read cheaper", () => {
  const ch = modelChannelRates("default");
  const withCache = costFromChannels(100_000, 10_000, 900_000, 0, ch);
  const noCache = costFromChannels(1_000_000, 10_000, 0, 0, ch);
  assert.ok(withCache < noCache);
});

test("1M Auto input tokens = \$1.25", () => {
  clearModelRatesCache();
  const cost = costFromChannels(
    1_000_000,
    0,
    0,
    0,
    modelChannelRates("auto")
  );
  assert.equal(cost, 1.25);
});
