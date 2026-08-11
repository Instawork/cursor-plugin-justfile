import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  clampScale,
  identityTransform,
  zoomBy,
  zoomAtPoint,
  fit,
  toCssTransform,
  MIN_SCALE,
  MAX_SCALE,
  ZOOM_STEP,
} = require("../out/panZoom.js");

test("clampScale clamps to min/max", () => {
  assert.equal(clampScale(0.01), MIN_SCALE);
  assert.equal(clampScale(100), MAX_SCALE);
  assert.equal(clampScale(1), 1);
  assert.equal(clampScale(NaN), 1);
});

test("zoomBy multiplies and clamps", () => {
  const base = identityTransform();
  const up = zoomBy(base, ZOOM_STEP);
  assert.ok(up.scale > 1);
  let state = { scale: MAX_SCALE, x: 0, y: 0 };
  state = zoomBy(state, ZOOM_STEP);
  assert.equal(state.scale, MAX_SCALE);
});

test("fit produces scale that fits with padding", () => {
  const state = fit({ width: 400, height: 300 }, { width: 800, height: 600 }, 16);
  assert.ok(state.scale <= 1);
  assert.ok(state.scale * 800 <= 400);
  assert.ok(state.scale * 600 <= 300);
});

test("zoomAtPoint keeps focal world point under cursor", () => {
  const before = { scale: 1, x: 0, y: 0 };
  const cx = 100;
  const cy = 50;
  const worldX = (cx - before.x) / before.scale;
  const worldY = (cy - before.y) / before.scale;
  const after = zoomAtPoint(before, 2, cx, cy);
  const worldX2 = (cx - after.x) / after.scale;
  const worldY2 = (cy - after.y) / after.scale;
  assert.ok(Math.abs(worldX - worldX2) < 1e-9);
  assert.ok(Math.abs(worldY - worldY2) < 1e-9);
});

test("identity reset", () => {
  const id = identityTransform();
  assert.deepEqual(id, { scale: 1, x: 0, y: 0 });
  assert.equal(toCssTransform(id), "translate(0px, 0px) scale(1)");
});
