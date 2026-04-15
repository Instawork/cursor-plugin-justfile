import * as path from "path";
import * as vscode from "vscode";
import type { CatalogItem } from "../types";
import { pathExists, walkFiles } from "../fsutil";
import { workspaceRelativeFor } from "../workspacePaths";

const FIND_EXCLUDE = "**/{node_modules,.git,dist,out,target}/**";

function itemFromAgentMd(fsPath: string, source: "workspace" | "user"): CatalogItem {
  return {
    id: `cursorAgents:${fsPath}`,
    kind: "cursorAgents",
    label: path.basename(fsPath, ".md"),
    fsPath,
    workspaceRelative: workspaceRelativeFor(fsPath),
    source,
    detail: fsPath.split(path.sep).join("/"),
  };
}

export async function indexWorkspaceCursorAgents(): Promise<CatalogItem[]> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }
  const uris = await vscode.workspace.findFiles("**/.cursor/agents/**/*.md", FIND_EXCLUDE, 1000);
  return uris
    .map((u) => itemFromAgentMd(u.fsPath, "workspace"))
    .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

export async function indexUserCursorAgents(homeCursor: string): Promise<CatalogItem[]> {
  const dir = path.join(homeCursor, "agents");
  if (!(await pathExists(dir))) {
    return [];
  }
  const files = await walkFiles(dir, (abs, name) => name.endsWith(".md"));
  return files.map((fsPath) => itemFromAgentMd(fsPath, "user")).sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}
