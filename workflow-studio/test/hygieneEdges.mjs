import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseMermaid, renderMermaidSVG } = require("../out/beautiful-mermaid-cjs.js");

const hygienePath = process.env.HYGIENE_WORKFLOW_MMD;

test("hygiene workflow has no edges to subgraph container ids", { skip: !hygienePath || !fs.existsSync(hygienePath) }, () => {
  const src = fs.readFileSync(hygienePath, "utf8");
  const parsed = parseMermaid(src);
  const subgraphIds = new Set((parsed.subgraphs || []).map((s) => s.id));
  const bad = [];
  for (const edge of parsed.edges || []) {
    if (subgraphIds.has(edge.from) || subgraphIds.has(edge.to)) {
      bad.push(`${edge.from} --> ${edge.to}`);
    }
  }
  assert.deepEqual(bad, []);
  const svg = renderMermaidSVG(src, { theme: "dark" });
  assert.ok(svg.length > 1000, "svg should render");
});
