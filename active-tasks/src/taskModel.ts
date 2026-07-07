export type TaskPr = { number: number; repo?: string | null; url: string };
export type TaskLink = { label: string; url: string };

export type ParsedSessionTodo = {
  id: string;
  label: string;
  done: boolean;
  repo?: string | null;
  title?: string;
  status?: string;
  pr_number?: number;
  pr_url?: string;
  branch?: string;
  worktree?: string;
  notes?: string;
  prs?: TaskPr[];
  links?: TaskLink[];
};

export type TaskFieldUpdate = {
  title?: string;
  status?: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  notes?: string;
  pr_number?: number | null;
  pr_url?: string;
};

type ActiveWorkRow = Record<string, unknown>;

function formatTitle(row: ActiveWorkRow): string {
  let title = String(row.title).trim();
  const prNumber = row.pr_number;
  const prUrl = row.pr_url;
  if (typeof prNumber === "number" && typeof prUrl === "string" && prUrl.trim()) {
    title = `[PR #${prNumber}](${prUrl.trim()}) ${title}`;
  }
  return `**${title}**`;
}

function formatExtras(row: ActiveWorkRow): string {
  const parts: string[] = [];
  const prs = row.prs;
  if (Array.isArray(prs)) {
    for (const pr of prs) {
      if (!pr || typeof pr !== "object") {
        continue;
      }
      const rec = pr as Record<string, unknown>;
      const num = rec.number;
      const url = rec.url;
      if (typeof num === "number" && typeof url === "string" && url.trim()) {
        parts.push(`[#${num}](${url.trim()})`);
      }
    }
  }
  if (typeof row.branch === "string" && row.branch.trim()) {
    parts.push(`\`${row.branch.trim()}\``);
  }
  if (typeof row.worktree === "string" && row.worktree.trim()) {
    parts.push(`worktree \`${row.worktree.trim()}\``);
  }
  if (typeof row.notes === "string" && row.notes.trim()) {
    parts.push(row.notes.trim());
  }
  return parts.join(" ");
}

export function taskRowToLabel(row: ActiveWorkRow): string {
  const chunks = [formatTitle(row), String(row.status).trim()];
  if (typeof row.repo === "string" && row.repo.trim()) {
    chunks.push(`\`${row.repo.trim()}\``);
  }
  const extras = formatExtras(row);
  if (extras) {
    chunks.push(extras);
  }
  return chunks.join(" — ");
}
