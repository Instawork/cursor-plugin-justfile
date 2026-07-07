import { spawn } from "child_process";
import { GITHUB_NAME_WITH_OWNER } from "./repoSlugs";
import type { ParsedSessionTodo as SessionTodo } from "./taskModel";

export type PrCheckSummary = {
  prUrl: string;
  state: string | null;
  reviewDecision: string | null;
  checks: { status: string; conclusion: string | null; name: string }[];
  rollup: "SUCCESS" | "FAILURE" | "PENDING" | "UNKNOWN";
  fetchedAt: string;
};

const GH_TIMEOUT_MS = 25_000;

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("gh timed out"));
    }, GH_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `gh exited ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function repoSlugForTodo(todo: SessionTodo): string | null {
  if (todo.repo && GITHUB_NAME_WITH_OWNER[todo.repo]) {
    return GITHUB_NAME_WITH_OWNER[todo.repo];
  }
  const url = todo.pr_url ?? todo.prs?.[0]?.url;
  if (!url) {
    return null;
  }
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull/);
  return m ? m[1] : null;
}

function prNumberForTodo(todo: SessionTodo): number | null {
  if (typeof todo.pr_number === "number") {
    return todo.pr_number;
  }
  const url = todo.pr_url ?? todo.prs?.[0]?.url;
  if (!url) {
    return null;
  }
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function rollupFromChecks(
  checks: PrCheckSummary["checks"]
): PrCheckSummary["rollup"] {
  if (!checks.length) {
    return "UNKNOWN";
  }
  if (
    checks.some(
      (c) =>
        c.status === "QUEUED" ||
        c.status === "IN_PROGRESS" ||
        c.status === "PENDING"
    )
  ) {
    return "PENDING";
  }
  if (
    checks.some(
      (c) => c.conclusion === "FAILURE" || c.conclusion === "CANCELLED"
    )
  ) {
    return "FAILURE";
  }
  if (
    checks.every(
      (c) =>
        c.conclusion === "SUCCESS" ||
        c.conclusion === "SKIPPED" ||
        c.conclusion === "NEUTRAL"
    )
  ) {
    return "SUCCESS";
  }
  return "UNKNOWN";
}

type GhCheckRun = {
  name?: string;
  status?: string;
  conclusion?: string | null;
};

type GhViewRow = {
  state?: string;
  reviewDecision?: string;
  statusCheckRollup?: GhCheckRun[];
};

export async function fetchPrStatusForTodo(
  todo: SessionTodo
): Promise<PrCheckSummary | null> {
  const slug = repoSlugForTodo(todo);
  const num = prNumberForTodo(todo);
  if (!slug || num === null) {
    return null;
  }
  try {
    const raw = await runGh([
      "pr",
      "view",
      String(num),
      "--repo",
      slug,
      "--json",
      "state,reviewDecision,statusCheckRollup",
    ]);
    const row = JSON.parse(raw.trim()) as GhViewRow;
    const checks: PrCheckSummary["checks"] = [];
    for (const ctx of row.statusCheckRollup ?? []) {
      checks.push({
        status: ctx.status ?? "UNKNOWN",
        conclusion: ctx.conclusion ?? null,
        name: ctx.name ?? "check",
      });
    }
    const prUrl =
      todo.pr_url ??
      `https://github.com/${slug}/pull/${num}`;
    return {
      prUrl,
      state: row.state ?? null,
      reviewDecision: row.reviewDecision ?? null,
      checks,
      rollup: rollupFromChecks(checks),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function fetchPrClosedState(
  slug: string,
  number: number
): Promise<string | null> {
  try {
    const raw = await runGh([
      "pr",
      "view",
      String(number),
      "--repo",
      slug,
      "--json",
      "state",
    ]);
    const row = JSON.parse(raw.trim()) as { state?: string };
    return row.state ?? null;
  } catch {
    return null;
  }
}

export async function enrichTodosWithPrStatus(
  todos: SessionTodo[],
  limit = 12
): Promise<Record<string, PrCheckSummary>> {
  const withPr = todos.filter((t) => prNumberForTodo(t) !== null);
  const slice = withPr.slice(0, limit);
  const out: Record<string, PrCheckSummary> = {};
  await Promise.all(
    slice.map(async (todo) => {
      const summary = await fetchPrStatusForTodo(todo);
      if (summary) {
        out[todo.id] = summary;
      }
    })
  );
  return out;
}
