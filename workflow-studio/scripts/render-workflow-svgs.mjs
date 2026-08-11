#!/usr/bin/env node
/**
 * Render SRE orchestrator .mmd files with the same beautiful-mermaid renderer
 * and pinned dark palette that Workflow Studio uses.
 *
 * Usage (from workflow-studio/):
 *   node scripts/render-workflow-svgs.mjs
 *   node scripts/render-workflow-svgs.mjs /path/to/sre-orchestrator
 */
import { createRequire } from "node:module";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Prefer compiled CJS bridge (after npm run compile); fall back to ESM package.
let renderMermaidSVG;
let theme;
try {
  ({ renderMermaidSVG } = require(join(root, "out", "beautiful-mermaid-cjs.js")));
  ({ WORKFLOW_STUDIO_THEME: theme } = require(join(root, "out", "theme.js")));
} catch {
  const bm = await import("beautiful-mermaid");
  renderMermaidSVG = bm.renderMermaidSVG;
  theme = {
    bg: "#0f1216",
    fg: "#d7dde6",
    surface: "#171b22",
    border: "#2a313d",
    line: "#2a313d",
    accent: "#4cc2ff",
    muted: "#8b95a7",
    transparent: true,
  };
}

const defaultOrchestrator = resolve(
  root,
  "../../instawork/.cursor/sre-orchestrator",
);
const orchestrator = resolve(process.argv[2] || defaultOrchestrator);

const dirs = await readdir(orchestrator, { withFileTypes: true });
let rendered = 0;
for (const entry of dirs) {
  if (!entry.isDirectory()) {
    continue;
  }
  const dir = join(orchestrator, entry.name);
  const files = await readdir(dir);
  const mmd = files.find((f) => f.endsWith(".mmd"));
  if (!mmd) {
    continue;
  }
  const source = await readFile(join(dir, mmd), "utf8");
  const svg = renderMermaidSVG(source, theme);
  const out = join(dir, mmd.replace(/\.mmd$/, ".svg"));
  await writeFile(out, svg, "utf8");
  console.log(`wrote ${out} (${svg.length} bytes)`);
  rendered += 1;
}

if (rendered === 0) {
  console.error(`No .mmd files found under ${orchestrator}`);
  process.exit(1);
}
console.log(`Rendered ${rendered} workflow SVG(s) with Workflow Studio theme.`);
