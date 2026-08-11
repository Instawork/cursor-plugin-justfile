import { sameWorktree } from "./paths";
import type { ParsedSessionTodo as SessionTodo } from "./taskModel";

/** Hard links + title near-dup (MEMORY_DEDUP_SIMILARITY). */
export type ConsolidationReasonCode =
  | "same_branch"
  | "same_worktree"
  | "shared_pr"
  | "title_near";

export type StructuralMergeCandidate = {
  reason: string;
  reasonCode: ConsolidationReasonCode;
  primaryId: string;
  mergeIds: string[];
  titles: string[];
};

export type AgentConsolidationHint = {
  openCount: number;
  /**
   * Open rows with no parent. Merging nests rows rather than deleting them, so
   * the recommendation has to count initiatives, not rows -- otherwise
   * consolidating never clears the banner it was prompted by.
   */
  rootCount: number;
  overRecommended: boolean;
  brief: string;
};

export type SemanticHit = {
  reasonCode: ConsolidationReasonCode;
  todo: SessionTodo;
};

export const RECOMMENDED_OPEN_MAX = 8;
/** Align with @beledarian/mcp-local-memory MEMORY_DEDUP_SIMILARITY default. */
export const DEFAULT_DEDUP_SIMILARITY = 0.9;
const TITLE_COMPARE_CAP = 64;
const RECENT_DONE_MAX = 12;
const RECENT_DONE_DAYS = 14;

const REASON_LABEL: Record<ConsolidationReasonCode, string> = {
  same_branch: "Same branch (safe to merge)",
  same_worktree: "Same worktree (safe to merge)",
  shared_pr: "Shared PR reference (duplicate tracking)",
  title_near: "Near-duplicate title (safe to merge)",
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
]);

export function dedupThreshold(
  env: NodeJS.ProcessEnv = process.env
): number {
  const parsed = Number.parseFloat(env.MEMORY_DEDUP_SIMILARITY ?? "");
  if (Number.isFinite(parsed)) {
    return Math.min(1, Math.max(0.5, parsed));
  }
  return DEFAULT_DEDUP_SIMILARITY;
}

function tokenizeTitle(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function contentTokenSet(text: string): Set<string> {
  return new Set(tokenizeTitle(text));
}

/** Port of Beledarian isNearDuplicate (token-set Jaccard ≥ threshold). */
export function titlesNearDuplicate(
  a: string,
  b: string,
  threshold: number = dedupThreshold()
): boolean {
  const normA = tokenizeTitle(a).join(" ");
  const normB = tokenizeTitle(b).join(" ");
  if (!normA || !normB) {
    return false;
  }
  if (normA === normB) {
    return true;
  }
  const setA = contentTokenSet(a);
  const setB = contentTokenSet(b);
  if (setA.size < 5 || setB.size < 5) {
    return false;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 && intersection / union >= threshold;
}

function prKeys(todo: Pick<SessionTodo, "pr_number" | "pr_url" | "repo" | "prs">): Set<string> {
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

function branchKey(todo: Pick<SessionTodo, "branch" | "repo">): string | null {
  const branch = todo.branch?.trim();
  if (!branch) {
    return null;
  }
  const repo = (todo.repo ?? "").trim();
  return `${repo}|${branch}`;
}

function worktreeKey(todo: Pick<SessionTodo, "worktree">): string | null {
  const wt = todo.worktree?.trim();
  return wt || null;
}

function titleOf(todo: Pick<SessionTodo, "title" | "label">): string {
  return (todo.title || todo.label || "").trim();
}

function structuralPairReason(
  a: SessionTodo,
  b: SessionTodo
): ConsolidationReasonCode | null {
  const keysA = prKeys(a);
  const keysB = prKeys(b);
  for (const k of keysA) {
    if (keysB.has(k)) {
      return "shared_pr";
    }
  }
  const branchA = a.branch?.trim();
  const branchB = b.branch?.trim();
  if (branchA && branchB && branchA === branchB) {
    const repoA = (a.repo ?? "").trim();
    const repoB = (b.repo ?? "").trim();
    if (!repoA || !repoB || repoA === repoB) {
      return "same_branch";
    }
  }
  if (sameWorktree(a.worktree, b.worktree)) {
    return "same_worktree";
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
    "title_near",
  ];
  for (const code of priority) {
    if (codes.includes(code)) {
      return code;
    }
  }
  return codes[0] ?? "shared_pr";
}

function addToBucket(
  map: Map<string, SessionTodo[]>,
  key: string | null,
  todo: SessionTodo
): void {
  if (!key) {
    return;
  }
  const list = map.get(key) ?? [];
  list.push(todo);
  map.set(key, list);
}

/** Pair todos that share an inverted-index bucket (O(n + matches), not all-pairs). */
function forEachIndexedPair(
  todos: SessionTodo[],
  visit: (a: SessionTodo, b: SessionTodo, reason: ConsolidationReasonCode) => void
): void {
  const byId = new Map(todos.map((t) => [t.id, t]));
  const prBuckets = new Map<string, SessionTodo[]>();
  const branchBuckets = new Map<string, SessionTodo[]>();
  const wtBuckets = new Map<string, SessionTodo[]>();

  for (const todo of todos) {
    for (const k of prKeys(todo)) {
      addToBucket(prBuckets, k, todo);
    }
    addToBucket(branchBuckets, branchKey(todo), todo);
    addToBucket(wtBuckets, worktreeKey(todo), todo);
  }

  const seen = new Set<string>();
  const visitPair = (
    a: SessionTodo,
    b: SessionTodo,
    reason: ConsolidationReasonCode
  ): void => {
    if (a.id === b.id) {
      return;
    }
    const key = [a.id, b.id].sort().join("|");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    visit(a, b, reason);
  };

  for (const bucket of prBuckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        visitPair(bucket[i], bucket[j], "shared_pr");
      }
    }
  }
  for (const bucket of branchBuckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const reason = structuralPairReason(bucket[i], bucket[j]);
        if (reason) {
          visitPair(bucket[i], bucket[j], reason);
        }
      }
    }
  }
  for (const bucket of wtBuckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const reason = structuralPairReason(bucket[i], bucket[j]);
        if (reason) {
          visitPair(bucket[i], bucket[j], reason);
        }
      }
    }
  }

  // Title near-dup within same repo (or both missing repo), capped.
  const byRepo = new Map<string, SessionTodo[]>();
  for (const todo of todos) {
    const repo = (todo.repo ?? "").trim() || "__none__";
    addToBucket(byRepo, repo, todo);
  }
  const threshold = dedupThreshold();
  for (const bucket of byRepo.values()) {
    const roots = bucket.filter((t) => !t.parent_id?.trim()).slice(0, TITLE_COMPARE_CAP);
    for (let i = 0; i < roots.length; i++) {
      for (let j = i + 1; j < roots.length; j++) {
        if (titlesNearDuplicate(titleOf(roots[i]), titleOf(roots[j]), threshold)) {
          visitPair(roots[i], roots[j], "title_near");
        }
      }
    }
  }

  void byId;
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

  forEachIndexedPair(todos, (a, b, reason) => {
    union(a.id, b.id);
    const key = [a.id, b.id].sort().join("|");
    const prev = pairCodes.get(key);
    if (!prev || reasonForGroup([prev, reason]) === reason) {
      pairCodes.set(key, reason);
    }
  });

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
    if (!codes.length) {
      continue;
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

function isRecentDone(todo: SessionTodo, nowMs: number): boolean {
  if (!todo.done) {
    return false;
  }
  const raw = todo.done_at || todo.updated_at;
  if (!raw) {
    return true;
  }
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) {
    return true;
  }
  return nowMs - t <= RECENT_DONE_DAYS * 24 * 60 * 60 * 1000;
}

function structuralMatchAgainst(
  candidate: Partial<SessionTodo>,
  todo: SessionTodo
): ConsolidationReasonCode | null {
  const candPr = prKeys(candidate as SessionTodo);
  if (candPr.size) {
    const todoPr = prKeys(todo);
    for (const k of candPr) {
      if (todoPr.has(k)) {
        return "shared_pr";
      }
    }
  }
  const branchA = candidate.branch?.trim();
  const branchB = todo.branch?.trim();
  if (branchA && branchB && branchA === branchB) {
    const repoA = (candidate.repo ?? "").trim();
    const repoB = (todo.repo ?? "").trim();
    if (!repoA || !repoB || repoA === repoB) {
      return "same_branch";
    }
  }
  if (
    candidate.worktree?.trim() &&
    todo.worktree?.trim() &&
    sameWorktree(candidate.worktree, todo.worktree)
  ) {
    return "same_worktree";
  }
  return null;
}

/**
 * Find an open or recent-done row that matches the candidate by PR / branch /
 * worktree, else title near-dup (MEMORY_DEDUP_SIMILARITY).
 */
export function findSemanticDuplicate(
  candidate: Partial<SessionTodo>,
  allTodos: SessionTodo[],
  now: Date = new Date()
): SemanticHit | null {
  const nowMs = now.getTime();
  const open = allTodos.filter((t) => !t.done && t.id);
  const recentDone = allTodos
    .filter((t) => isRecentDone(t, nowMs))
    .sort((a, b) => {
      const ta = Date.parse(a.done_at || a.updated_at || "") || 0;
      const tb = Date.parse(b.done_at || b.updated_at || "") || 0;
      return tb - ta;
    })
    .slice(0, RECENT_DONE_MAX);

  const pools: SessionTodo[][] = [open, recentDone];
  for (const pool of pools) {
    for (const todo of pool) {
      const reason = structuralMatchAgainst(candidate, todo);
      if (reason) {
        return { reasonCode: reason, todo };
      }
    }
  }

  const candTitle = titleOf(candidate as SessionTodo);
  if (!candTitle) {
    return null;
  }
  const threshold = dedupThreshold();
  const candRepo = (candidate.repo ?? "").trim();

  const titlePool: SessionTodo[] = [];
  for (const todo of open) {
    if (todo.parent_id?.trim()) {
      continue;
    }
    const repo = (todo.repo ?? "").trim();
    if (!candRepo || !repo || candRepo === repo) {
      titlePool.push(todo);
    }
  }
  for (const todo of recentDone) {
    const repo = (todo.repo ?? "").trim();
    if (!candRepo || !repo || candRepo === repo) {
      titlePool.push(todo);
    }
  }

  for (const todo of titlePool.slice(0, TITLE_COMPARE_CAP)) {
    if (titlesNearDuplicate(candTitle, titleOf(todo), threshold)) {
      return { reasonCode: "title_near", todo };
    }
  }
  return null;
}

export function reasonLabel(code: ConsolidationReasonCode): string {
  return REASON_LABEL[code];
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
    "Pick PRIMARY as the initiative row; selected rows become **nested subtasks** (`parent_id`). Each row keeps its own PRs, tags, and notes.",
    "",
    "### Rows",
    lines.length ? lines.join("\n") : "(none open)",
  ].join("\n");
}

export function buildAgentConsolidationHint(
  todos: SessionTodo[]
): AgentConsolidationHint {
  const open = todos.filter((t) => !t.done);
  const roots = open.filter((t) => !t.parent_id?.trim());
  return {
    openCount: open.length,
    rootCount: roots.length,
    overRecommended: roots.length > RECOMMENDED_OPEN_MAX,
    brief: buildAgentConsolidationBrief(open),
  };
}

export function enrichDiscoveryWithConsolidation<T extends object>(
  discovery: T,
  todos: SessionTodo[]
): T & { agentConsolidation: AgentConsolidationHint } {
  return {
    ...discovery,
    agentConsolidation: buildAgentConsolidationHint(todos),
  };
}
