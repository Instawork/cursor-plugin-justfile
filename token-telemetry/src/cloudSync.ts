import {
  Agent,
  type Run,
  type SDKAgentInfo,
  type TokenUsage,
} from "@cursor/sdk";
import * as vscode from "vscode";
import { getCloudApiKey } from "./cloudSecrets";
import type { CloudSyncStatus } from "./cloudSyncTypes";
import { knownCloudRunIds } from "./dbQuery";
import { ingestUsageRecords, type IngestRecord } from "./ingestCli";
import { defaultPaths } from "./telemetry";

export type { CloudSyncStatus } from "./cloudSyncTypes";

const TERMINAL_RUN_STATUSES = new Set(["finished", "error", "cancelled"]);

function lookbackCutoffMs(lookbackDays: number): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - lookbackDays);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function sanitizeSyncError(message: string): string {
  return message.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
}

function cloudRunLabel(agent: SDKAgentInfo, run: Run): string {
  const name = agent.name?.trim() || agent.agentId.slice(0, 12);
  const branch = run.git?.branches?.[0];
  if (branch?.prUrl) {
    return `☁ ${name} · PR`;
  }
  if (branch?.branch) {
    return `☁ ${name} · ${branch.branch}`;
  }
  return `☁ ${name}`;
}

function modelId(run: Run): string {
  const id = run.model?.id;
  return id ? String(id) : "";
}

function runTimestampIso(run: Run): string {
  if (run.createdAt && Number.isFinite(run.createdAt)) {
    return new Date(run.createdAt).toISOString();
  }
  return new Date().toISOString();
}

async function resolveUsage(run: Run): Promise<TokenUsage | undefined> {
  if (run.usage) {
    return run.usage;
  }
  if (run.status === "running") {
    return undefined;
  }
  if (run.supports("wait")) {
    try {
      const result = await run.wait();
      if (result.usage) {
        return result.usage;
      }
    } catch {
      /* fall through */
    }
  }
  if (!run.supports("stream")) {
    return undefined;
  }
  let last: TokenUsage | undefined;
  try {
    for await (const event of run.stream()) {
      if (event.type === "usage") {
        last = event.usage;
      }
    }
  } catch {
    return last;
  }
  return last;
}

function toIngestRecord(
  agent: SDKAgentInfo,
  run: Run,
  usage: TokenUsage
): IngestRecord {
  return {
    event: "cloudRun",
    run_id: run.id,
    agent_id: agent.agentId,
    model: modelId(run),
    at: runTimestampIso(run),
    conversation: cloudRunLabel(agent, run),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      totalTokens: usage.totalTokens,
    },
  };
}

async function listAllCloudAgents(apiKey: string): Promise<SDKAgentInfo[]> {
  const agents: SDKAgentInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await Agent.list({
      runtime: "cloud",
      apiKey,
      limit: 50,
      cursor,
      includeArchived: false,
    });
    for (const item of page.items) {
      if (item.agentId.startsWith("bc-")) {
        agents.push(item);
      }
    }
    cursor = page.nextCursor;
  } while (cursor && agents.length < 200);
  return agents;
}

async function listRecentRuns(
  agentId: string,
  apiKey: string,
  cutoffMs: number,
  knownIds: Set<string>
): Promise<Run[]> {
  const runs: Run[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await Agent.listRuns(agentId, {
      runtime: "cloud",
      apiKey,
      limit: 50,
      cursor,
    });
    let stop = false;
    for (const run of page.items) {
      if (knownIds.has(run.id)) {
        stop = true;
        break;
      }
      if (run.createdAt && run.createdAt < cutoffMs) {
        stop = true;
        break;
      }
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        continue;
      }
      runs.push(run);
    }
    if (stop) {
      break;
    }
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < 8);
  return runs;
}

export async function syncCloudAgentUsage(
  extensionPath: string,
  apiKey: string,
  options: { lookbackDays: number; maxIngestPerSync: number }
): Promise<{ ingested: number }> {
  const { csvPath } = defaultPaths();
  const known = await knownCloudRunIds(extensionPath, csvPath);
  const cutoffMs = lookbackCutoffMs(options.lookbackDays);
  const agents = await listAllCloudAgents(apiKey);
  agents.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
  const pending: IngestRecord[] = [];

  for (const agent of agents) {
    if (pending.length >= options.maxIngestPerSync) {
      break;
    }
    const runs = await listRecentRuns(agent.agentId, apiKey, cutoffMs, known);
    for (const listed of runs) {
      if (pending.length >= options.maxIngestPerSync) {
        break;
      }
      if (known.has(listed.id)) {
        continue;
      }
      let run = listed;
      if (!run.usage && run.supports("wait")) {
        try {
          run = await Agent.getRun(listed.id, {
            runtime: "cloud",
            agentId: agent.agentId,
            apiKey,
          });
        } catch {
          continue;
        }
      }
      const usage = await resolveUsage(run);
      if (!usage || usage.totalTokens <= 0) {
        continue;
      }
      pending.push(toIngestRecord(agent, run, usage));
      known.add(run.id);
    }
  }

  const ingested = await ingestUsageRecords(extensionPath, pending);
  return { ingested };
}

export function loadCloudSyncStatus(
  context: vscode.ExtensionContext,
  lastError: string | null,
  lastRunsIngested?: number
): CloudSyncStatus {
  const cfg = vscode.workspace.getConfiguration("tokenTelemetry.cloudSync");
  const storedIngested =
    context.globalState.get<number>("cloudSync.lastIngested") ?? 0;
  return {
    apiKeyConfigured: false,
    enabled: cfg.get<boolean>("enabled", true),
    lastSyncAt: context.globalState.get<string>("cloudSync.lastAt") ?? null,
    lastError: lastError ? sanitizeSyncError(lastError) : null,
    lastRunsIngested: lastRunsIngested ?? storedIngested,
  };
}

export async function refreshCloudSyncStatus(
  context: vscode.ExtensionContext,
  secrets: vscode.SecretStorage,
  lastError: string | null,
  lastRunsIngested?: number
): Promise<CloudSyncStatus> {
  const base = loadCloudSyncStatus(context, lastError, lastRunsIngested);
  base.apiKeyConfigured = (await getCloudApiKey(secrets)) !== undefined;
  return base;
}

export async function markCloudSyncComplete(
  context: vscode.ExtensionContext,
  ingested: number
): Promise<void> {
  await context.globalState.update("cloudSync.lastAt", new Date().toISOString());
  await context.globalState.update("cloudSync.lastIngested", ingested);
}

/** For CI/scripts: ingest one SDK RunResult after await run.wait(). */
export async function ingestFromRunResult(
  extensionPath: string,
  args: {
    agentId: string;
    runId: string;
    model?: string;
    at?: string;
    conversation?: string;
    usage: TokenUsage;
  }
): Promise<number> {
  return ingestUsageRecords(extensionPath, [
    {
      event: "cloudRun",
      run_id: args.runId,
      agent_id: args.agentId,
      model: args.model,
      at: args.at,
      conversation: args.conversation ?? `☁ ${args.agentId.slice(0, 12)}`,
      usage: {
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        cacheReadTokens: args.usage.cacheReadTokens,
        cacheWriteTokens: args.usage.cacheWriteTokens,
        totalTokens: args.usage.totalTokens,
      },
    },
  ]);
}
