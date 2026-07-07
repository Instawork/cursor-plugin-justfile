import type { ParsedSessionTodo as SessionTodo } from "./taskModel";

/** Hard links only — semantic “same initiative” is agent judgment. */
export type ConsolidationReasonCode =
  | "same_branch"
  | "same_worktree"
  | "shared_pr";

export type StructuralMergeCandidate = {
  reason: string;
  reasonCode: ConsolidationReasonCode;
  primaryId: string;
  mergeIds: string[];
  titles: string[];
};

export type AgentConsolidationHint = {
  openCount: number;
  overRecommended: boolean;
  brief: string;
};

export const RECOMMENDED_OPEN_MAX = 8;

const REASON_LABEL: Record<ConsolidationReasonCode, string> = {
  same_branch: "Same branch (safe to merge)",
  same_worktree: "Same worktree (safe to merge)",
  shared_pr: "Shared PR reference (duplicate tracking)",
};

function prKeys(todo: SessionTodo): Set<string> {
  const keys = new Set<string>();
  if (typeof todo.pr_number === "number") {
    const repo = todo.repo ?? "";
    keys.add(`${repo}#${todo.pr_number}`);
    if (todo.pr_url?.trim()) {
      keys.add(todo.pr_url.trim());
    }
  }
  for (const pr of todo.prs ?? []) {
    const repo = pr.repo ?? todo.repo ?? "";
    keys.add(`${repo}#${pr.number}`);
    if (pr.url?.trim()) {
      keys.add(pr.url.trim());
    }
  }
  return keys;
}

function structuralPairReason(
  a: SessionTodo,
  b: SessionTodo
): ConsolidationReasonCode | null {
  const branchA = a.branch?.trim();
  const branchB = b.branch?.trim();
  if (branchA && branchB && branchA === branchB) {
    return "same_branch";
  }
  const wtA = a.worktree?.trim();
  const wtB = b.worktree?.trim();
  if (wtA && wtB && wtA === wtB) {
    return "same_worktree";
  }
  const keysA = prKeys(a);
  const keysB = prKeys(b);
  for (const k of keysA) {
    if (keysB.has(k)) {
      return "shared_pr";
    }
  }
  return null;
}

function pickPrimary(group: SessionTodo[]): SessionTodo {
  const withPr = group.find((t) => typeof t.pr_number === "number");
  if (withPr) {
    return withPr;
  }
  return group[0];
}

function reasonForGroup(codes: ConsolidationReasonCode[]): ConsolidationReasonCode {
  const priority: ConsolidationReasonCode[] = [
    "shared_pr",
    "same_branch",
    "same_worktree",
  ];
  for (const code of priority) {
    if (codes.includes(code)) {
      return code;
    }
  }
  return codes[0] ?? "shared_pr";
}

/** One-click merges for unambiguous duplicates only. */
export function suggestStructuralMerges(
  openTodos: SessionTodo[]
): StructuralMergeCandidate[] {
  const todos = openTodos.filter((t) => !t.done && t.id);
  if (todos.length < 2) {
    return [];
  }

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let p = parent.get(id) ?? id;
    if (p !== id) {
      p = find(p);
      parent.set(id, p);
    }
    return p;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };

  const pairCodes = new Map<string, ConsolidationReasonCode>();

  for (let i = 0; i < todos.length; i++) {
    for (let j = i + 1; j < todos.length; j++) {
      const reason = structuralPairReason(todos[i], todos[j]);
      if (!reason) {
        continue;
      }
      union(todos[i].id, todos[j].id);
      const key = [todos[i].id, todos[j].id].sort().join("|");
      pairCodes.set(key, reason);
    }
  }

  const components = new Map<string, SessionTodo[]>();
  for (const todo of todos) {
    const root = find(todo.id);
    const list = components.get(root) ?? [];
    list.push(todo);
    components.set(root, list);
  }

  const suggestions: StructuralMergeCandidate[] = [];
  for (const group of components.values()) {
    if (group.length < 2) {
      continue;
    }
    const codes: ConsolidationReasonCode[] = [];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const key = [group[i].id, group[j].id].sort().join("|");
        const c = pairCodes.get(key);
        if (c) {
          codes.push(c);
        }
      }
    }
    const primary = pickPrimary(group);
    const mergeIds = group
      .filter((t) => t.id !== primary.id)
      .map((t) => t.id);
    const reasonCode = reasonForGroup(codes);
    suggestions.push({
      reason: REASON_LABEL[reasonCode],
      reasonCode,
      primaryId: primary.id,
      mergeIds,
      titles: group.map((t) => t.title ?? t.label),
    });
  }

  suggestions.sort((a, b) => b.mergeIds.length - a.mergeIds.length);
  return suggestions;
}

export function buildAgentConsolidationBrief(
  openTodos: SessionTodo[]
): string {
  const mergeCli =
    "python3.11 ~/code/cursor-contexts/scripts/active_tasks_db.py merge-work PRIMARY_UUID MERGE_UUID …";
  const lines = openTodos.map((t) => {
    const parts = [
      `- \`${t.id}\` **${t.title ?? t.label}**`,
      t.status ? `— ${t.status}` : "",
      t.repo ? `(\`${t.repo}\`)` : "",
      t.branch ? `branch \`${t.branch}\`` : "",
      typeof t.pr_number === "number" ? `PR #${t.pr_number}` : "",
      t.notes ? `— ${t.notes}` : "",
    ].filter(Boolean);
    return parts.join(" ");
  });

  return [
    "## Consolidate active work (agent)",
    "",
    `Open rows: **${openTodos.length}** (target **3–${RECOMMENDED_OPEN_MAX}** initiatives).`,
    "",
    "Use judgment: merge rows that are one initiative (multi-repo deploy, paired PRs, same feature split across repos). Do **not** merge unrelated work.",
    "",
    "After deciding groups, run merge for each group:",
    "",
    "```bash",
    mergeCli,
    "```",
    "",
    "Pick PRIMARY as the row to keep (best title/status); extra PRs land in `prs_json`. Re-run `items` and trim to 3–8 rows.",
    "",
    "### Rows",
    lines.length ? lines.join("\n") : "(none open)",
  ].join("\n");
}

export function buildAgentConsolidationHint(
  todos: SessionTodo[]
): AgentConsolidationHint {
  const open = todos.filter((t) => !t.done);
  return {
    openCount: open.length,
    overRecommended: open.length > RECOMMENDED_OPEN_MAX,
    brief: buildAgentConsolidationBrief(open),
  };
}

export function enrichDiscoveryWithConsolidation<
  T extends {
    structuralMergeCandidates?: StructuralMergeCandidate[];
    agentConsolidation?: AgentConsolidationHint;
  },
>(discovery: T, todos: SessionTodo[]): T {
  const open = todos.filter((t) => !t.done);
  return {
    ...discovery,
    structuralMergeCandidates: suggestStructuralMerges(open),
    agentConsolidation: buildAgentConsolidationHint(todos),
  };
}
