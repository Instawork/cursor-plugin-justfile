import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export type GitKind =
  | "modified"
  | "untracked"
  | "ignored"
  | "added"
  | "deleted"
  | "renamed"
  | "conflicted";

const PRIORITY: Record<GitKind, number> = {
  conflicted: 70,
  deleted: 60,
  renamed: 50,
  untracked: 40,
  added: 30,
  modified: 20,
  ignored: 10,
};

function stronger(a: GitKind | undefined, b: GitKind): GitKind {
  if (!a) {
    return b;
  }
  return PRIORITY[b] > PRIORITY[a] ? b : a;
}

/** First field of porcelain v1 is two status chars (index + work tree). */
function classifyPorcelainStatus(xy: string): GitKind | undefined {
  if (xy === "??") {
    return "untracked";
  }
  if (xy === "!!") {
    return "ignored";
  }
  if (xy.length !== 2) {
    return undefined;
  }
  const x = xy[0]!;
  const y = xy[1]!;
  if (x === "U" || y === "U" || xy === "AA" || xy === "DD") {
    return "conflicted";
  }
  if (x === "R" || y === "R" || x === "C" || y === "C") {
    return "renamed";
  }
  if (y === "D" || x === "D") {
    return "deleted";
  }
  if (xy === "AM" || xy === "MM") {
    return "modified";
  }
  if (x === "A" || y === "A") {
    return "added";
  }
  if (x === "M" || y === "M") {
    return "modified";
  }
  return undefined;
}

function parsePorcelainPathField(field: string): string {
  const t = field.trim();
  const arrow = " -> ";
  if (t.includes(arrow)) {
    const i = t.lastIndexOf(arrow);
    return t.slice(i + arrow.length).trim();
  }
  return t;
}

function parsePorcelainLine(line: string): { xy: string; relPath: string } | undefined {
  if (line.length < 4) {
    return undefined;
  }
  const xy = line.slice(0, 2);
  if (line[2] !== " ") {
    return undefined;
  }
  const relPath = parsePorcelainPathField(line.slice(3));
  if (!relPath) {
    return undefined;
  }
  return { xy, relPath: relPath.split(path.sep).join("/") };
}

async function isGitWorkspaceRoot(absRoot: string): Promise<boolean> {
  const gitPath = path.join(absRoot, ".git");
  try {
    const st = await fs.stat(gitPath);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * Map tree keys (`resolveAbs` / `DirRow.relPath`) to Git decoration kind.
 * Single-root: paths relative to the folder. Multi-root: `FolderName/rest`.
 */
async function loadWorkspaceGitDecorations(): Promise<Map<string, GitKind>> {
  const map = new Map<string, GitKind>();
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return map;
  }
  const multi = folders.length > 1;

  for (const wf of folders) {
    const root = wf.uri.fsPath;
    if (!(await isGitWorkspaceRoot(root))) {
      continue;
    }
    let stdout: string;
    try {
      const r = await execFileAsync(
        "git",
        ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--ignored"],
        {
          cwd: root,
          maxBuffer: 8 * 1024 * 1024,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      stdout = typeof r.stdout === "string" ? r.stdout : String(r.stdout);
    } catch {
      continue;
    }

    const prefix = multi ? `${wf.name}/` : "";

    for (const line of stdout.split("\n")) {
      if (!line) {
        continue;
      }
      const parsed = parsePorcelainLine(line);
      if (!parsed) {
        continue;
      }
      const kind = classifyPorcelainStatus(parsed.xy);
      if (!kind) {
        continue;
      }
      const key = prefix + parsed.relPath;
      map.set(key, stronger(map.get(key), kind));
    }
  }

  return map;
}

const STALE_MS = 600;
let cachedDecorations: Map<string, GitKind> = new Map();
let fetchedAt = 0;
let inflight: Promise<Map<string, GitKind>> | null = null;

export function invalidateGitDecorationCache(): void {
  fetchedAt = 0;
}

/** Cached git decoration map; refreshes after `STALE_MS` or when invalidated. */
export async function getGitDecorationsForWorkspace(): Promise<Map<string, GitKind>> {
  const now = Date.now();
  if (fetchedAt > 0 && now - fetchedAt < STALE_MS) {
    return cachedDecorations;
  }
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    const m = await loadWorkspaceGitDecorations();
    cachedDecorations = m;
    fetchedAt = Date.now();
    return m;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
