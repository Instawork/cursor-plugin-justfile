import type { PromptBinding } from "./directives";
import type { StructureEntry } from "./types";

const NODE_ID =
  /\b([A-Za-z][A-Za-z0-9_]*)\b(?:\s*(?:\[[^\]]*\]|\([^\)]*\)|\{[^\}]*\}|\>\|[^\|]*\|))/g;

export function extractNodeIds(mermaidSource: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of mermaidSource.matchAll(NODE_ID)) {
    const id = match[1];
    if (seen.has(id) || id === "flowchart" || id === "graph" || id === "subgraph" || id === "end") {
      continue;
    }
    seen.add(id);
    ids.push(id);
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

  const byNode = new Map(bindings.map((b) => [b.nodeId, b]));
  const nodeIds = extractNodeIds(mermaidSource);
  for (const nodeId of nodeIds) {
    const binding = byNode.get(nodeId);
    if (binding) {
      entries.push({
        kind: "step",
        label: nodeId,
        nodeId,
        relativePath: binding.relativePath,
        bound: true,
      });
      byNode.delete(nodeId);
    } else {
      entries.push({
        kind: "unbound",
        label: nodeId,
        nodeId,
        bound: false,
      });
    }
  }

  for (const orphan of byNode.values()) {
    entries.push({
      kind: "step",
      label: `${orphan.nodeId} (orphan binding)`,
      nodeId: orphan.nodeId,
      relativePath: orphan.relativePath,
      bound: true,
    });
  }

  return entries;
}
