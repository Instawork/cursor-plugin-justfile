import * as path from "path";
import { parsePromptDirectives } from "./directives";

export interface AutomaticBinding {
  nodeId: string;
  relativePath: string;
  stepKey: string;
}

export interface AutomaticBindingPlan {
  status: "ready" | "existing" | "no-prompts" | "incomplete";
  bindings: AutomaticBinding[];
  diagnostics: string[];
}

interface NumberedNode {
  nodeId: string;
  stepKey: string;
}

const SQUARE_NODE = /\b([A-Za-z][A-Za-z0-9_]*)\s*\[\s*(?:"([^"]+)"|([^\]\r\n]+))\s*\]/g;

export function numberedPromptKey(relativePath: string): string | undefined {
  const stem = path.basename(relativePath, path.extname(relativePath));
  const match = /^0*(\d+)(?:-([a-z]))?-/i.exec(stem);
  if (!match) {
    return undefined;
  }
  return normalizeStepKey(match[1], match[2]);
}

export function numberedLabelKey(label: string): string | undefined {
  const match = /^\s*0*(\d+)(?:-?([a-z]))?(?=\s|[-·:]|$)/i.exec(label);
  if (!match) {
    return undefined;
  }
  return normalizeStepKey(match[1], match[2]);
}

export function extractNumberedNodes(mermaidSource: string): NumberedNode[] {
  const nodes: NumberedNode[] = [];
  const seen = new Set<string>();

  for (const rawLine of mermaidSource.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("%%") || line.startsWith("subgraph")) {
      continue;
    }
    for (const match of line.matchAll(SQUARE_NODE)) {
      const nodeId = match[1];
      const label = (match[2] || match[3] || "").trim();
      const stepKey = numberedLabelKey(label);
      if (!stepKey || seen.has(nodeId)) {
        continue;
      }
      seen.add(nodeId);
      nodes.push({ nodeId, stepKey });
    }
  }

  return nodes;
}

export function planAutomaticBindings(
  mermaidSource: string,
  relativePromptPaths: string[],
): AutomaticBindingPlan {
  if (parsePromptDirectives(mermaidSource).bindings.length > 0) {
    return { status: "existing", bindings: [], diagnostics: [] };
  }

  const prompts = relativePromptPaths
    .map((relativePath) => ({ relativePath, stepKey: numberedPromptKey(relativePath) }))
    .filter((prompt): prompt is { relativePath: string; stepKey: string } => !!prompt.stepKey)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  if (prompts.length === 0) {
    return { status: "no-prompts", bindings: [], diagnostics: [] };
  }

  const diagnostics: string[] = [];
  const promptsByKey = groupBy(prompts, (prompt) => prompt.stepKey);
  for (const [stepKey, matches] of promptsByKey) {
    if (matches.length > 1) {
      diagnostics.push(
        `Auto-bind step ${stepKey}: multiple prompt files (${matches
          .map((prompt) => prompt.relativePath)
          .join(", ")})`,
      );
    }
  }

  const nodesByKey = groupBy(extractNumberedNodes(mermaidSource), (node) => node.stepKey);
  const bindings: AutomaticBinding[] = [];
  for (const prompt of prompts) {
    const candidates = nodesByKey.get(prompt.stepKey) || [];
    if (candidates.length === 0) {
      const nearMiss = [...nodesByKey.keys()].filter(
        (key) => key === prompt.stepKey || key.startsWith(`${prompt.stepKey}-`),
      );
      const hint = nearMiss.length
        ? ` Closest labels are step ${nearMiss.join(", ")} — rename the prompt to match (for example 0${prompt.stepKey}-${nearMiss[0].split("-")[1] ?? ""}-*.md).`
        : "";
      diagnostics.push(
        `Auto-bind ${prompt.relativePath}: no node label starts with step ${prompt.stepKey}.${hint}`,
      );
      continue;
    }
    if (candidates.length > 1) {
      diagnostics.push(
        `Auto-bind ${prompt.relativePath}: step ${prompt.stepKey} is ambiguous (${candidates
          .map((node) => node.nodeId)
          .join(", ")})`,
      );
      continue;
    }
    bindings.push({
      nodeId: candidates[0].nodeId,
      relativePath: prompt.relativePath,
      stepKey: prompt.stepKey,
    });
  }

  if (diagnostics.length > 0 || bindings.length !== prompts.length) {
    return { status: "incomplete", bindings: [], diagnostics };
  }
  return { status: "ready", bindings, diagnostics: [] };
}

function normalizeStepKey(number: string, suffix?: string): string {
  const normalizedNumber = String(Number.parseInt(number, 10));
  return suffix ? `${normalizedNumber}-${suffix.toLowerCase()}` : normalizedNumber;
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey) || [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return groups;
}
