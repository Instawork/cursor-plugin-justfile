import { spawn } from "child_process";
import { repoKeyFromNameWithOwner } from "./repoSlugs";

export type OpenGitHubPr = {
  number: number;
  title: string;
  url: string;
  nameWithOwner: string;
  repoKey: string | null;
  relation: "authored" | "review_requested";
  isDraft: boolean;
};

const GITHUB_PR_URL =
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i;

/** Validate webview-posted PR payloads before writing to SQLite. */
export function coerceOpenGitHubPr(raw: unknown): OpenGitHubPr | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.number !== "number" || !Number.isFinite(o.number)) {
    return null;
  }
  if (typeof o.url !== "string") {
    return null;
  }
  const url = o.url.trim();
  const m = url.match(GITHUB_PR_URL);
  if (!m) {
    return null;
  }
  const numberFromUrl = Number(m[2]);
  if (numberFromUrl !== o.number) {
    return null;
  }
  const nameWithOwner =
    typeof o.nameWithOwner === "string" && o.nameWithOwner.trim()
      ? o.nameWithOwner.trim()
      : m[1];
  if (nameWithOwner.toLowerCase() !== m[1].toLowerCase()) {
    return null;
  }
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (!title) {
    return null;
  }
  const relation =
    o.relation === "review_requested" ? "review_requested" : "authored";
  return {
    number: o.number,
    title,
    url: `https://github.com/${m[1]}/pull/${m[2]}`,
    nameWithOwner,
    repoKey: repoKeyFromNameWithOwner(nameWithOwner),
    relation,
    isDraft: Boolean(o.isDraft),
  };
}

type GhPrRow = {
  number: number;
  title: string;
  url: string;
  isDraft?: boolean;
  repository?: { nameWithOwner?: string };
};

function runGhSearch(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `gh exited ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseRows(raw: string): GhPrRow[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((row): row is GhPrRow => {
    return (
      !!row &&
      typeof row === "object" &&
      typeof (row as GhPrRow).number === "number" &&
      typeof (row as GhPrRow).title === "string" &&
      typeof (row as GhPrRow).url === "string"
    );
  });
}

function toOpenPr(
  row: GhPrRow,
  relation: OpenGitHubPr["relation"]
): OpenGitHubPr | null {
  const nameWithOwner = row.repository?.nameWithOwner?.trim();
  if (!nameWithOwner) {
    return null;
  }
  return {
    number: row.number,
    title: row.title.trim(),
    url: row.url.trim(),
    nameWithOwner,
    repoKey: repoKeyFromNameWithOwner(nameWithOwner),
    relation,
    isDraft: Boolean(row.isDraft),
  };
}

export async function fetchOpenGitHubPrs(): Promise<{
  items: OpenGitHubPr[];
  error: string | null;
}> {
  const jsonFields = "number,title,url,repository,isDraft";
  const base = [
    "search",
    "prs",
    "--state=open",
    "--json",
    jsonFields,
    "--limit",
    "50",
  ];
  try {
    const [authoredRaw, reviewRaw] = await Promise.all([
      runGhSearch([...base, "--author=@me"]),
      runGhSearch([...base, "--review-requested=@me"]),
    ]);
    const byUrl = new Map<string, OpenGitHubPr>();
    for (const row of parseRows(authoredRaw)) {
      const pr = toOpenPr(row, "authored");
      if (pr) {
        byUrl.set(pr.url, pr);
      }
    }
    for (const row of parseRows(reviewRaw)) {
      const pr = toOpenPr(row, "review_requested");
      if (!pr) {
        continue;
      }
      const existing = byUrl.get(pr.url);
      if (existing) {
        if (existing.relation === "authored") {
          existing.relation = "authored";
        }
        continue;
      }
      byUrl.set(pr.url, pr);
    }
    const items = [...byUrl.values()].sort((a, b) => {
      const repo = (a.repoKey ?? a.nameWithOwner).localeCompare(
        b.repoKey ?? b.nameWithOwner
      );
      if (repo !== 0) {
        return repo;
      }
      return b.number - a.number;
    });
    return { items, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { items: [], error: msg };
  }
}
