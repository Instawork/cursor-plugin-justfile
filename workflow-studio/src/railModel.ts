import type { StructureEntry } from "./types";

export type RailSectionId = "bound" | "unbound" | "diagnostics";

export interface RailSection {
  id: RailSectionId;
  label: string;
  count: number;
  entries: StructureEntry[];
}

export interface GroupedRail {
  sections: RailSection[];
  flat: StructureEntry[];
}

function matchesFilter(entry: StructureEntry, query: string): boolean {
  if (!query) {
    return true;
  }
  const q = query.toLowerCase();
  const label = (entry.label || "").toLowerCase();
  const path = (entry.relativePath || "").toLowerCase();
  const nodeId = (entry.nodeId || "").toLowerCase();
  const fileKey = (entry.fileKey || "").toLowerCase();
  return (
    label.includes(q) || path.includes(q) || nodeId.includes(q) || fileKey.includes(q)
  );
}

/**
 * Group structure into Bound / Unbound / Diagnostics.
 * Bound entries keep file → member nesting order from buildStructure.
 */
export function groupRail(
  structure: StructureEntry[],
  diagnostics: string[],
  filterQuery = "",
): GroupedRail {
  const query = filterQuery.trim();
  const bound: StructureEntry[] = [];
  const unbound: StructureEntry[] = [];
  for (const entry of structure) {
    if (!matchesFilter(entry, query)) {
      continue;
    }
    if (entry.bound) {
      bound.push(entry);
    } else {
      unbound.push(entry);
    }
  }
  const diagEntries: StructureEntry[] = [];
  const filteredDiags = diagnostics.filter((d) => {
    if (!query) {
      return true;
    }
    return d.toLowerCase().includes(query.toLowerCase());
  });
  for (const d of filteredDiags) {
    diagEntries.push({
      kind: "unbound",
      label: d,
      bound: false,
    });
  }

  const sections: RailSection[] = [
    { id: "bound", label: "Bound", count: bound.length, entries: bound },
    { id: "unbound", label: "Unbound", count: unbound.length, entries: unbound },
    { id: "diagnostics", label: "Diagnostics", count: diagEntries.length, entries: diagEntries },
  ];
  return {
    sections,
    flat: [...bound, ...unbound],
  };
}

/** Clamp-style next index (no wrap). */
export function nextIndex(current: number, length: number): number {
  if (length <= 0) {
    return -1;
  }
  if (current < 0) {
    return 0;
  }
  return Math.min(length - 1, current + 1);
}

/** Clamp-style previous index (no wrap). */
export function prevIndex(current: number, length: number): number {
  if (length <= 0) {
    return -1;
  }
  if (current < 0) {
    return 0;
  }
  return Math.max(0, current - 1);
}

/**
 * Next unbound nodeId after selected (by flat unbound order), wrapping.
 * If selected is null/missing, returns the first unbound nodeId.
 */
export function nextUnbound(
  structure: StructureEntry[],
  selectedNodeId: string | null,
): string | null {
  const unbound = structure.filter((e) => !e.bound && e.nodeId);
  if (unbound.length === 0) {
    return null;
  }
  if (!selectedNodeId) {
    return unbound[0].nodeId ?? null;
  }
  const idx = unbound.findIndex((e) => e.nodeId === selectedNodeId);
  if (idx < 0) {
    return unbound[0].nodeId ?? null;
  }
  const next = unbound[(idx + 1) % unbound.length];
  return next.nodeId ?? null;
}

export function indexOfNode(flat: StructureEntry[], nodeId: string | null): number {
  if (!nodeId) {
    return -1;
  }
  return flat.findIndex((e) => e.nodeId === nodeId);
}

/** All node ids that share a file with the selected node (or just the node). */
export function memberNodeIdsForSelection(
  structure: StructureEntry[],
  selectedNodeId: string | null,
): string[] {
  if (!selectedNodeId) {
    return [];
  }
  const selected = structure.find((e) => e.nodeId === selectedNodeId);
  if (!selected) {
    return [selectedNodeId];
  }
  if (selected.kind === "file" && selected.fileKey) {
    return structure
      .filter((e) => e.kind === "step" && e.fileKey === selected.fileKey && e.nodeId)
      .map((e) => e.nodeId!);
  }
  if (selected.fileKey) {
    return structure
      .filter((e) => e.kind === "step" && e.fileKey === selected.fileKey && e.nodeId)
      .map((e) => e.nodeId!);
  }
  return [selectedNodeId];
}
