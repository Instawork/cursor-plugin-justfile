import { Agent, type Run, type SDKAgentInfo } from "@cursor/sdk";
import { cloudApiTimeoutMs, withTimeout } from "./ghExec";

export type CloudAgentThread = {
  agentId: string;
  name: string;
  url: string;
  runStatus: Run["status"] | null;
  branch: string | null;
  prUrl: string | null;
  lastModified: number | null;
  active: boolean;
};

const ACTIVE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_AGENTS = 40;
const RUNS_TIMEOUT_MS = 8_000;

function agentDashboardUrl(agentId: string): string {
  return `https://cursor.com/agents/${encodeURIComponent(agentId)}`;
}

function branchFromRun(run: Run | undefined): {
  branch: string | null;
  prUrl: string | null;
} {
  const info = run?.git?.branches?.[0];
  return {
    branch: info?.branch?.trim() || null,
    prUrl: info?.prUrl?.trim() || null,
  };
}

async function listCloudAgents(apiKey: string): Promise<SDKAgentInfo[]> {
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
  agents.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
  return agents.slice(0, MAX_AGENTS);
}

export async function fetchCloudAgentThreads(
  apiKey: string
): Promise<{ items: CloudAgentThread[]; error: string | null }> {
  try {
    return await withTimeout(
      "Cloud agents API",
      cloudApiTimeoutMs(),
      () => fetchCloudAgentThreadsInner(apiKey)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      items: [],
      error: msg.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]"),
    };
  }
}

async function fetchCloudAgentThreadsInner(
  apiKey: string
): Promise<{ items: CloudAgentThread[]; error: string | null }> {
  const cutoff = Date.now() - ACTIVE_LOOKBACK_MS;
  try {
    const agents = await listCloudAgents(apiKey);
    const items: CloudAgentThread[] = [];

    for (const agent of agents) {
      const lastModified =
        typeof agent.lastModified === "number" ? agent.lastModified : null;
      if (lastModified !== null && lastModified < cutoff) {
        continue;
      }

      let latestRun: Run | undefined;
      try {
        const page = await withTimeout("Cloud agent runs", RUNS_TIMEOUT_MS, () =>
          Agent.listRuns(agent.agentId, {
            runtime: "cloud",
            apiKey,
            limit: 1,
          })
        );
        latestRun = page.items[0];
      } catch {
        /* skip run details */
      }

      const runStatus = latestRun?.status ?? null;
      const isRunning = runStatus === "running";
      const recent =
        lastModified !== null && lastModified >= cutoff;
      if (!isRunning && !recent) {
        continue;
      }

      const { branch, prUrl } = branchFromRun(latestRun);
      const name = agent.name?.trim() || agent.agentId.slice(0, 12);
      items.push({
        agentId: agent.agentId,
        name,
        url: agentDashboardUrl(agent.agentId),
        runStatus,
        branch,
        prUrl,
        lastModified,
        active: isRunning || recent,
      });
    }

    items.sort((a, b) => {
      const ar = a.runStatus === "running" ? 1 : 0;
      const br = b.runStatus === "running" ? 1 : 0;
      if (ar !== br) {
        return br - ar;
      }
      return (b.lastModified ?? 0) - (a.lastModified ?? 0);
    });

    return { items, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { items: [], error: msg.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]") };
  }
}
