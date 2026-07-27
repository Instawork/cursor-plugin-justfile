#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "module";
import { join } from "path";

const require = createRequire(
  new URL("../package.json", import.meta.url)
);
const { reconcileExtraWithScanHold } = require(join(import.meta.dirname, "../out/payload.js"));

test("reconcileExtraWithScanHold keeps prior count while scan pending", () => {
  const prev = {
    missingPrs: [{ number: 1, url: "u", repo: "instawork" }],
    untrackedCloudAgents: [],
    staleTrackedPrs: [],
    scannedAt: "2026-01-01T00:00:00Z",
  };
  const empty = {
    missingPrs: [],
    untrackedCloudAgents: [],
    staleTrackedPrs: [],
    scannedAt: undefined,
  };
  assert.equal(reconcileExtraWithScanHold(empty, true, prev), 1);
  assert.equal(reconcileExtraWithScanHold(empty, false, prev), 0);
  assert.equal(reconcileExtraWithScanHold(prev, true, empty), 1);
});
