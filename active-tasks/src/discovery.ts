import type { ParsedSessionTodo as SessionTodo } from "./taskModel";
import {
  attachOpenPrToWork,
  dismissDiscovery,
  insertWorkFromOpenPr,
  listDiscoveryDismissals,
  mergeWorkRowsIntoPrimary,
} from "./activeTasksStore";
import type { CloudAgentThread } from "./cloudAgentThreads";
import { fetchCloudAgentThreads } from "./cloudAgentThreads";
import { getCloudApiKey } from "./cloudSecrets";
import { fetchOpenGitHubPrs, type OpenGitHubPr } from "./githubOpenPrs";
import {
  filterMissingPrsForFeed,
  filterUntrackedCloudForFeed,
  reconcileFeedSummary,
} from "./reconcileFeed";
import {
  enrichTodosWithPrStatus,
  fetchPrClosedState,
  type PrCheckSummary,
} from "./githubPrStatus";
import { GITHUB_NAME_WITH_OWNER, prNumberFromUrl, repoKeyFromNameWithOwner } from "./repoSlugs";
import {
  detectWorkspaceMatch,
  todoMatchesWorkspace,
  type WorkspaceMatch,
} from "./workspaceContext";
import * as vscode from "vscode";

import type {
  AgentConsolidationHint,
  StructuralMergeCandidate,
} from "./workConsolidation";

export type StaleTrackedPr = {
  todoId: string;
  title: string;
  prUrl: string;
  prNumber: number;
  nameWithOwner: string;
  state: string | null;
};

export type ReconcileFeedInfo = {
  backfill: boolean;
  watermarkAt: string | null;
  includeReviewRequested: boolean;
};

export type TaskDiscoverySnapshot = {
  scannedAt: string | null;
  githubError: string | null;
  cloudError: string | null;
  missingPrs: OpenGitHubPr[];
  cloudAgents: CloudAgentThread[];
  untrackedCloudAgents: CloudAgentThread[];
  staleTrackedPrs: StaleTrackedPr[];
  prStatusByTodoId: Record<string, PrCheckSummary>;
  workspace: WorkspaceMatch;
  structuralMergeCandidates: StructuralMergeCandidate[];
  agentConsolidation: AgentConsolidationHint;
  reconcileFeed: ReconcileFeedInfo;
};

let cached: TaskDiscoverySnapshot | null = null;
let cachedAt = 0;
let inflight: Promise<TaskDiscoverySnapshot> | null = null;

const CACHE_MS = 3 * 60 * 1000;

function repoMatchesTodo(
  todo: SessionTodo,
  repoKey: string | null,
  nameWithOwner: string
): boolean {
  if (!todo.repo) {
    return true;
  }
  if (repoKey && todo.repo === repoKey) {
    return true;
  }
  const slug = repoKeyFromNameWithOwner(nameWithOwner);
  return slug === todo.repo;
}

export function isPrTrackedInTodos(
  todos: SessionTodo[],
  pr: Pick<OpenGitHubPr, "number" | "url" | "nameWithOwner" | "repoKey">
): boolean {
  for (const todo of todos) {
    if (
      todo.pr_number === pr.number &&
      repoMatchesTodo(todo, pr.repoKey, pr.nameWithOwner)
    ) {
      return true;
    }
    if (todo.pr_url && todo.pr_url.trim() === pr.url) {
      return true;
    }
    for (const extra of todo.prs ?? []) {
      if (extra.number !== pr.number) {
        continue;
      }
      if (!extra.repo || !pr.repoKey || extra.repo === pr.repoKey) {
        return true;
      }
      if (extra.url.trim() === pr.url) {
        return true;
      }
    }
  }
  return false;
}

export function isCloudThreadTracked(
  todos: SessionTodo[],
  thread: CloudAgentThread
): boolean {
  const prNum = prNumberFromUrl(thread.prUrl ?? undefined);
  for (const todo of todos) {
    if (thread.branch && todo.branch && thread.branch === todo.branch) {
      return true;
    }
    if (prNum !== null && todo.pr_number === prNum) {
      return true;
    }
    if (thread.prUrl && todo.pr_url && thread.prUrl === todo.pr_url) {
      return true;
    }
    for (const extra of todo.prs ?? []) {
      if (prNum !== null && extra.number === prNum) {
        return true;
      }
    }
  }
  return false;
}

function dismissKey(kind: string, ref: string): string {
  return `${kind}:${ref}`;
}

function filterDismissed<T extends { url?: string; agentId?: string }>(
  kind: string,
  items: T[],
  dismissed: Set<string>,
  ref: (item: T) => string
): T[] {
  return items.filter((item) => !dismissed.has(dismissKey(kind, ref(item))));
}

async function findStaleTrackedPrs(
  todos: SessionTodo[],
  openUrls: Set<string>
): Promise<StaleTrackedPr[]> {
  const candidates: {
    todoId: string;
    title: string;
    url: string;
    number: number;
    slug: string;
  }[] = [];
  for (const todo of todos) {
    const urls: { url: string; number: number; slug: string }[] = [];
    if (todo.pr_url && typeof todo.pr_number === "number") {
      const slug =
        (todo.repo && GITHUB_NAME_WITH_OWNER[todo.repo]) ||
        todo.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1] ||
        "";
      if (slug) {
        urls.push({ url: todo.pr_url, number: todo.pr_number, slug });
      }
    }
    for (const extra of todo.prs ?? []) {
      const slug =
        (extra.repo && GITHUB_NAME_WITH_OWNER[extra.repo]) ||
        extra.url.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1] ||
        "";
      if (slug) {
        urls.push({ url: extra.url, number: extra.number, slug });
      }
    }
    for (const pr of urls) {
      if (openUrls.has(pr.url)) {
        continue;
      }
      candidates.push({
        todoId: todo.id,
        title: todo.title ?? todo.label,
        url: pr.url,
        number: pr.number,
        slug: pr.slug,
      });
    }
  }

  const slice = candidates.slice(0, 20);
  const stale: StaleTrackedPr[] = [];
  const concurrency = 4;
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < slice.length) {
      const i = idx++;
      const pr = slice[i];
      const state = await fetchPrClosedState(pr.slug, pr.number);
      if (state === "OPEN") {
        continue;
      }
      stale.push({
        todoId: pr.todoId,
        title: pr.title,
        prUrl: pr.url,
        prNumber: pr.number,
        nameWithOwner: pr.slug,
        state,
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, slice.length) }, () => worker())
  );
  return stale;
}

function emptyReconcileFeed(): ReconcileFeedInfo {
  const s = reconcileFeedSummary();
  return {
    backfill: s.backfill,
    watermarkAt:
      s.watermarkMs !== null ? new Date(s.watermarkMs).toISOString() : null,
    includeReviewRequested: s.includeReviewRequested,
  };
}

function emptyDiscovery(workspace: WorkspaceMatch): TaskDiscoverySnapshot {
  return {
    scannedAt: null,
    githubError: null,
    cloudError: null,
    missingPrs: [],
    cloudAgents: [],
    untrackedCloudAgents: [],
    staleTrackedPrs: [],
    prStatusByTodoId: {},
    workspace,
    structuralMergeCandidates: [],
    agentConsolidation: {
      openCount: 0,
      overRecommended: false,
      brief: "",
    },
    reconcileFeed: emptyReconcileFeed(),
  };
}

async function scanDiscovery(
  secrets: vscode.SecretStorage,
  todos: SessionTodo[],
  workspace: WorkspaceMatch
): Promise<TaskDiscoverySnapshot> {
  const dismissed = listDiscoveryDismissals();
  const feed = reconcileFeedSummary();
  const [gh, apiKey] = await Promise.all([
    fetchOpenGitHubPrs({
      includeReviewRequested: feed.includeReviewRequested,
    }),
    getCloudApiKey(secrets),
  ]);

  let cloud = { items: [] as CloudAgentThread[], error: null as string | null };
  if (apiKey) {
    cloud = await fetchCloudAgentThreads(apiKey);
  } else {
    cloud.error = "No Cloud API key (Active Tasks or Token Telemetry)";
  }

  const openUrls = new Set(gh.items.map((p) => p.url));
  const untrackedPrs = gh.items.filter((pr) => !isPrTrackedInTodos(todos, pr));
  const missingAfterWatermark = filterMissingPrsForFeed(
    untrackedPrs,
    feed.watermarkMs
  );
  const missingPrs = filterDismissed(
    "pr",
    missingAfterWatermark,
    dismissed,
    (p) => p.url
  );
  const cloudAgents = cloud.items;
  const untrackedCloudRaw = cloud.items.filter(
    (thread) => !isCloudThreadTracked(todos, thread)
  );
  const untrackedAfterWatermark = filterUntrackedCloudForFeed(
    untrackedCloudRaw,
    feed.watermarkMs
  );
  const untrackedCloudAgents = filterDismissed(
    "cloud",
    untrackedAfterWatermark,
    dismissed,
    (a) => a.agentId
  );

  const staleTrackedPrs = await findStaleTrackedPrs(todos, openUrls);
  const prStatusByTodoId = await enrichTodosWithPrStatus(
    todos.filter((t) => !t.done)
  );

  return {
    scannedAt: new Date().toISOString(),
    githubError: gh.error,
    cloudError: cloud.error,
    missingPrs,
    cloudAgents,
    untrackedCloudAgents,
    staleTrackedPrs,
    prStatusByTodoId,
    workspace,
    structuralMergeCandidates: [],
    agentConsolidation: {
      openCount: 0,
      overRecommended: false,
      brief: "",
    },
    reconcileFeed: {
      backfill: feed.backfill,
      watermarkAt:
        feed.watermarkMs !== null
          ? new Date(feed.watermarkMs).toISOString()
          : null,
      includeReviewRequested: feed.includeReviewRequested,
    },
  };
}

export async function loadTaskDiscovery(
  secrets: vscode.SecretStorage,
  todos: SessionTodo[],
  workspace: WorkspaceMatch,
  options?: { force?: boolean }
): Promise<TaskDiscoverySnapshot> {
  const now = Date.now();
  if (!options?.force && cached && now - cachedAt < CACHE_MS) {
    return { ...cached, workspace };
  }
  if (inflight) {
    if (options?.force) {
      await inflight.catch(() => undefined);
    } else {
      return inflight;
    }
  }

  inflight = scanDiscovery(secrets, todos, workspace)
    .then((result) => {
      cached = result;
      cachedAt = Date.now();
      return result;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function peekTaskDiscovery(
  workspace: WorkspaceMatch
): TaskDiscoverySnapshot {
  if (!cached) {
    return emptyDiscovery(workspace);
  }
  return { ...cached, workspace };
}

export function invalidateTaskDiscoveryCache(): void {
  cached = null;
  cachedAt = 0;
}

export { todoMatchesWorkspace };

export function reconcileAddPr(pr: OpenGitHubPr): string | null {
  return insertWorkFromOpenPr(pr);
}

export function reconcileAttachPr(workId: string, pr: OpenGitHubPr): boolean {
  return attachOpenPrToWork(workId, pr);
}

export function reconcileDismissItem(kind: string, refKey: string): void {
  dismissDiscovery(kind, refKey);
}

export function reconcileMergeWorkRows(
  primaryId: string,
  mergeIds: string[]
): boolean {
  return mergeWorkRowsIntoPrimary(primaryId, mergeIds);
}
