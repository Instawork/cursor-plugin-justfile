import type { OpenGitHubPr } from "./githubOpenPrs";
import type { CloudAgentThread } from "./cloudAgentThreads";

function parseIsoMs(iso: string | undefined | null): number | null {
  if (!iso?.trim()) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** PR activity time for incremental filter (prefer updatedAt). */
export function prActivityMs(pr: OpenGitHubPr): number | null {
  return parseIsoMs(pr.updatedAt) ?? parseIsoMs(pr.createdAt);
}

export function filterMissingPrsForFeed(
  prs: OpenGitHubPr[],
  watermarkMs: number | null
): OpenGitHubPr[] {
  if (watermarkMs === null) {
    return prs;
  }
  return prs.filter((pr) => {
    const activity = prActivityMs(pr);
    if (activity === null) {
      return false;
    }
    return activity > watermarkMs;
  });
}

export function filterUntrackedCloudForFeed(
  agents: CloudAgentThread[],
  watermarkMs: number | null
): CloudAgentThread[] {
  if (watermarkMs === null) {
    return agents;
  }
  return agents.filter((a) => {
    if (typeof a.lastModified !== "number") {
      return false;
    }
    return a.lastModified > watermarkMs;
  });
}
