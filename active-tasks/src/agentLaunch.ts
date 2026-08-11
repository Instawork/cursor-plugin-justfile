import { Agent } from "@cursor/sdk";
import { cloudApiTimeoutMs, withTimeout } from "./ghExec";
import { GITHUB_NAME_WITH_OWNER } from "./repoSlugs";
import type { ParsedSessionTodo as SessionTodo } from "./taskModel";

export type LaunchResult = {
  agentId: string;
  url: string;
};

/**
 * The safety rules a subagent must be told, because it inherits none of them.
 * Kept here rather than in the webview so a UI edit cannot quietly drop them.
 */
const SAFETY_PREAMBLE = [
  "Rules for this task (you inherit none of them, so they are stated here):",
  "- Never read, quote, or summarize secret-bearing files: **/.env*, **/*secret*, src/config/local.py. Never output credentials or PII.",
  "- Never create or edit .cursor/rules/*.mdc or any AGENTS.md.",
  "- Do not commit, push, or open a PR unless this brief explicitly says to.",
  "- Never force-push and never use --no-verify.",
  "- Your working directory is already on the right branch. Do not run `git checkout`.",
  "- Emit no title bar or status rail. Start directly with the answer.",
  "",
  "Hand back exactly these sections:",
  "## Changed",
  "## Verified   <command> — pass | fail | not run",
  "## Blocked",
  "## Next",
].join("\n");

/**
 * Instawork worktrees cannot verify locally: scripts/bin/entry.sh hardcodes the
 * container name, so `just pytest` from a worktree execs into the primary
 * clone's source. Saying so up front prevents a false green handoff.
 */
const INSTAWORK_VERIFY_NOTE =
  "This is an instawork worktree. `just pytest` here runs against the primary " +
  "clone's container, not your worktree, so it cannot verify your changes. " +
  "Report `## Verified — not run` and say why. Do not claim a local suite result.";

export function buildAgentPrompt(todo: SessionTodo): string {
  const parts = [SAFETY_PREAMBLE, "", `Task: ${todo.title ?? todo.label}`];
  if (todo.next_action?.trim()) {
    parts.push(`Next action: ${todo.next_action.trim()}`);
  }
  if (todo.notes?.trim()) {
    parts.push(`Notes: ${todo.notes.trim()}`);
  }
  if (todo.branch?.trim()) {
    parts.push(`Branch: ${todo.branch.trim()}`);
  }
  if (todo.worktree?.trim()) {
    parts.push(`Worktree: ${todo.worktree.trim()}`);
  }
  if (todo.repo === "instawork") {
    parts.push("", INSTAWORK_VERIFY_NOTE);
  }
  return parts.join("\n");
}

export function repoUrlForTodo(todo: SessionTodo): string | null {
  const slug = todo.repo ? GITHUB_NAME_WITH_OWNER[todo.repo] : undefined;
  return slug ? `https://github.com/${slug}` : null;
}

/**
 * Start a cloud agent for a roster row.
 *
 * Cloud rather than local: a local agent would run inside the extension host
 * process for the lifetime of the task, which is not something a panel button
 * should start. The caller is responsible for writing `cloud_agent_id` back.
 */
export async function launchCloudAgentForTask(
  todo: SessionTodo,
  apiKey: string
): Promise<LaunchResult> {
  const repoUrl = repoUrlForTodo(todo);
  if (!repoUrl) {
    throw new Error(
      `Task has no repo mapped to a GitHub URL (repo=${todo.repo ?? "none"}).`
    );
  }
  const branch = todo.branch?.trim();
  const agent = await withTimeout(
    "Launch cloud agent",
    cloudApiTimeoutMs(),
    () =>
      Agent.create({
        apiKey,
        name: (todo.title ?? todo.label).slice(0, 80),
        cloud: {
          repos: [{ url: repoUrl, ...(branch ? { startingRef: branch } : {}) }],
          workOnCurrentBranch: Boolean(branch),
          autoCreatePR: false,
        },
      })
  );
  try {
    await withTimeout("Send cloud agent prompt", cloudApiTimeoutMs(), () =>
      agent.send(buildAgentPrompt(todo))
    );
  } finally {
    agent.close();
  }
  return {
    agentId: agent.agentId,
    url: `https://cursor.com/agents/${encodeURIComponent(agent.agentId)}`,
  };
}
