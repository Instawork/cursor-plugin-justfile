/** Parent-chain helpers for nested active_work rows (parent_id). */

export type ParentLink = { id: string; parent_id: string | null };

export function parentIdMap(rows: ParentLink[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const row of rows) {
    const pid = row.parent_id?.trim();
    map.set(row.id, pid || null);
  }
  return map;
}

/** True if `nodeId` is the same as or nested under `ancestorId`. */
export function isUnderAncestor(
  parentMap: Map<string, string | null>,
  nodeId: string,
  ancestorId: string
): boolean {
  let cur: string | null = nodeId;
  while (cur) {
    if (cur === ancestorId) {
      return true;
    }
    cur = parentMap.get(cur) ?? null;
  }
  return false;
}

/** Insert `childId` after `parentId`'s subtree in a flat id list. */
export function insertAfterSubtreeInOrder(
  orderIds: string[],
  parentId: string,
  childId: string,
  parentMap: Map<string, string | null>
): string[] {
  const without = orderIds.filter((id) => id !== childId);
  const idx = without.indexOf(parentId);
  if (idx < 0) {
    without.push(childId);
    return without;
  }
  let end = idx + 1;
  while (
    end < without.length &&
    isUnderAncestor(parentMap, without[end]!, parentId)
  ) {
    end += 1;
  }
  without.splice(end, 0, childId);
  return without;
}
