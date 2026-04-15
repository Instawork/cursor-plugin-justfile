import * as path from "path";
import * as vscode from "vscode";
import type { CatalogItem } from "../types";
import { pathExists, walkFiles } from "../fsutil";
import { workspaceRelativeFor } from "../workspacePaths";

const FIND_EXCLUDE = "**/{node_modules,.git,dist,out,target}/**";

/** Skip template / helper markdown under skills (not entrypoints). */
function isSkillEntryMarkdown(fsPath: string): boolean {
  const relFromCursor = relativeAfterCursorSkills(fsPath);
  if (relFromCursor === undefined) {
    return false;
  }
  const segments = relFromCursor.split("/").filter(Boolean);
  return !segments.some((s) => s === "assets" || s === "scripts");
}

/** Path after `/.cursor/skills/` (posix), or undefined. */
function relativeAfterCursorSkills(fsPath: string): string | undefined {
  const norm = fsPath.split(path.sep).join("/");
  const needle = "/.cursor/skills/";
  const i = norm.indexOf(needle);
  if (i < 0) {
    return undefined;
  }
  return norm.slice(i + needle.length);
}

function skillLabel(fsPath: string): string {
  const base = path.basename(fsPath);
  if (base === "SKILL.md") {
    return path.basename(path.dirname(fsPath));
  }
  return path.basename(fsPath, ".md");
}

function toPosix(fsPath: string): string {
  return fsPath.split(path.sep).join("/");
}

function skillItem(fsPath: string, source: "workspace" | "user"): CatalogItem {
  return {
    id: `skill:${fsPath}`,
    kind: "skill",
    label: skillLabel(fsPath),
    fsPath,
    workspaceRelative: workspaceRelativeFor(fsPath),
    source,
    detail: toPosix(fsPath),
  };
}

export async function indexWorkspaceSkills(): Promise<CatalogItem[]> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }
  const uris = await vscode.workspace.findFiles("**/.cursor/skills/**/*.md", FIND_EXCLUDE, 2000);
  const items = uris
    .map((u) => u.fsPath)
    .filter(isSkillEntryMarkdown)
    .map((fsPath) => skillItem(fsPath, "workspace"));
  return dedupeByPath(items).sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

function underSkillsRoot(abs: string, skillsRoot: string): boolean {
  const root = path.normalize(skillsRoot);
  const file = path.normalize(abs);
  return file === root || file.startsWith(root + path.sep);
}

function relativeUnderSkillsRoot(abs: string, skillsRoot: string): string {
  return path.relative(skillsRoot, abs).split(path.sep).join("/");
}

async function collectSkillMdFromTree(skillsRoot: string, source: "workspace" | "user"): Promise<CatalogItem[]> {
  const files = await walkFiles(skillsRoot, (abs, name) => name.endsWith(".md"));
  const out: CatalogItem[] = [];
  for (const fsPath of files) {
    if (!underSkillsRoot(fsPath, skillsRoot)) {
      continue;
    }
    const rel = relativeUnderSkillsRoot(fsPath, skillsRoot);
    if (rel.split("/").some((s) => s === "assets" || s === "scripts")) {
      continue;
    }
    out.push(skillItem(fsPath, source));
  }
  return out;
}

export async function indexUserSkillsDefault(homeCursor: string): Promise<CatalogItem[]> {
  const roots = [
    path.join(homeCursor, "skills-cursor"),
    path.join(homeCursor, "skills"),
  ];
  const out: CatalogItem[] = [];
  for (const root of roots) {
    if (await pathExists(root)) {
      out.push(...(await collectSkillMdFromTree(root, "user")));
    }
  }
  return dedupeByPath(out);
}

export async function indexExtraSkillRoots(extraRoots: string[]): Promise<CatalogItem[]> {
  const out: CatalogItem[] = [];
  for (const raw of extraRoots) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const expanded = trimmed.startsWith("~") ? path.join(process.env.HOME ?? "", trimmed.slice(1)) : trimmed;
    if (await pathExists(expanded)) {
      const st = await vscode.workspace.fs.stat(vscode.Uri.file(expanded));
      if (st.type === vscode.FileType.Directory) {
        out.push(...(await collectSkillMdFromTree(expanded, "user")));
      }
    }
  }
  return dedupeByPath(out);
}

function dedupeByPath(items: CatalogItem[]): CatalogItem[] {
  const seen = new Set<string>();
  const res: CatalogItem[] = [];
  for (const it of items) {
    if (!seen.has(it.fsPath)) {
      seen.add(it.fsPath);
      res.push(it);
    }
  }
  return res;
}
