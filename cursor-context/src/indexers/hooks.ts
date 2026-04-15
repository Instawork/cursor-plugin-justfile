import * as path from "path";
import * as vscode from "vscode";
import type { CatalogItem } from "../types";
import { pathExists, walkFiles } from "../fsutil";
import { workspaceRelativeFor } from "../workspacePaths";

const FIND_EXCLUDE = "**/{node_modules,.git,dist,out,target}/**";

export async function indexWorkspaceHooks(): Promise<CatalogItem[]> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }
  const out: CatalogItem[] = [];
  const manifests = await vscode.workspace.findFiles("**/.cursor/hooks.json", FIND_EXCLUDE, 100);
  for (const u of manifests) {
    out.push({
      id: `hookManifest:${u.fsPath}`,
      kind: "hookManifest",
      label: "hooks.json",
      fsPath: u.fsPath,
      workspaceRelative: workspaceRelativeFor(u.fsPath),
      source: "workspace",
      detail: u.fsPath,
    });
  }
  const scripts = await vscode.workspace.findFiles("**/.cursor/hooks/**", FIND_EXCLUDE, 500);
  for (const u of scripts) {
    const fsPath = u.fsPath;
    out.push({
      id: `hook:${fsPath}`,
      kind: "hook",
      label: path.basename(fsPath),
      fsPath,
      workspaceRelative: workspaceRelativeFor(fsPath),
      source: "workspace",
      detail: fsPath,
    });
  }
  return dedupe(out).sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

async function collectHooksJson(fsPath: string, source: "workspace" | "user"): Promise<CatalogItem | null> {
  if (!(await pathExists(fsPath))) {
    return null;
  }
  return {
    id: `hookManifest:${fsPath}`,
    kind: "hookManifest",
    label: "hooks.json",
    fsPath,
    workspaceRelative: workspaceRelativeFor(fsPath),
    source,
    detail: fsPath,
  };
}

async function collectHookScripts(hooksDir: string, source: "workspace" | "user"): Promise<CatalogItem[]> {
  if (!(await pathExists(hooksDir))) {
    return [];
  }
  const files = await walkFiles(hooksDir, () => true);
  return files.map((fsPath) => ({
    id: `hook:${fsPath}`,
    kind: "hook" as const,
    label: path.basename(fsPath),
    fsPath,
    workspaceRelative: workspaceRelativeFor(fsPath),
    source,
    detail: fsPath,
  }));
}

export async function indexUserHooks(homeCursor: string): Promise<CatalogItem[]> {
  const out: CatalogItem[] = [];
  const manifest = await collectHooksJson(path.join(homeCursor, "hooks.json"), "user");
  if (manifest) {
    out.push(manifest);
  }
  out.push(...(await collectHookScripts(path.join(homeCursor, "hooks"), "user")));
  return dedupe(out);
}

function dedupe(items: CatalogItem[]): CatalogItem[] {
  const m = new Map<string, CatalogItem>();
  for (const it of items) {
    if (!m.has(it.id)) {
      m.set(it.id, it);
    }
  }
  return [...m.values()];
}
