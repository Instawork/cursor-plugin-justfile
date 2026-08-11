import type { PromptBinding } from "./directives";
import type { StructureEntry } from "./types";

// Bundled CJS bridge — see scripts/bundle-beautiful-mermaid-cjs.mjs
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseMermaid } = require("./beautiful-mermaid-cjs.js") as {
  parseMermaid: (text: string) => { nodes: Map<string, unknown>; subgraphs: unknown[] };
};

const RESERVED_IDS = new Set(["flowchart", "graph", "subgraph", "end", "direction"]);

export function extractNodeIds(mermaidSource: string): string[] {
  try {
    const graph = parseMermaid(mermaidSource);
    const ids: string[] = [];
    for (const id of graph.nodes.keys()) {
      if (RESERVED_IDS.has(id)) {
        continue;
      }
      ids.push(id);
    }
    return ids;
  } catch {
    return extractNodeIdsLegacy(mermaidSource);
  }
}

const NODE_ID =
  /\b([A-Za-z][A-Za-z0-9_]*)\b(?:\s*(?:\[[^\]]*\]|\([^\)]*\)|\{[^\}]*\}|\>\|[^\|]*\|))/g;
const SUBGRAPH_DECL = /^subgraph\b\s*([A-Za-z][A-Za-z0-9_]*)?/;

/** Fallback when beautiful-mermaid cannot parse the source. */
export function extractNodeIdsLegacy(mermaidSource: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const skip = new Set<string>(RESERVED_IDS);

  for (const rawLine of mermaidSource.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("%%")) {
      continue;
    }
    const subgraph = SUBGRAPH_DECL.exec(line);
    if (subgraph) {
      if (subgraph[1]) {
        skip.add(subgraph[1]);
      }
      continue;
    }
    for (const match of line.matchAll(NODE_ID)) {
      const id = match[1];
      if (seen.has(id) || skip.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

export function buildStructure(
  _diagramPath: string,
  bindings: PromptBinding[],
  mermaidSource: string,
): StructureEntry[] {
  const entries: StructureEntry[] = [];
  entries.push({
    kind: "controller",
    label: "WORKFLOW.md",
    relativePath: "WORKFLOW.md",
    bound: true,
  });

  const nodeIds = extractNodeIds(mermaidSource);
  const nodeSet = new Set(nodeIds);
  const claimed = new Set<string>();

  for (const binding of bindings) {
    const members = binding.memberNodeIds.length > 0 ? binding.memberNodeIds : [binding.nodeId];
    const fileKey = binding.relativePath;

    entries.push({
      kind: "file",
      label: binding.relativePath,
      relativePath: binding.relativePath,
      nodeId: binding.nodeId,
      fileKey,
      bound: true,
    });

    for (const memberId of members) {
      claimed.add(memberId);
      const inGraph = nodeSet.has(memberId);
      entries.push({
        kind: "step",
        label: inGraph ? memberId : `${memberId} (orphan binding)`,
        nodeId: memberId,
        relativePath: binding.relativePath,
        fileKey,
        bound: true,
      });
    }
  }

  for (const nodeId of nodeIds) {
    if (claimed.has(nodeId)) {
      continue;
    }
    entries.push({
      kind: "unbound",
      label: nodeId,
      nodeId,
      bound: false,
    });
  }

  return entries;
}
