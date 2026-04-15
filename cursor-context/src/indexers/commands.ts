import * as path from "path";
import * as vscode from "vscode";
import type { CatalogItem } from "../types";
import { walkFiles } from "../fsutil";
import { workspaceRelativeFor } from "../workspacePaths";

const FIND_EXCLUDE = "**/{node_modules,.git,dist,out,target}/**";

export async function indexWorkspaceCommands(): Promise<CatalogItem[]> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }
  const uris = await vscode.workspace.findFiles("**/.cursor/commands/**/*.md", FIND_EXCLUDE, 500);
  return uris
    .map((u) => {
      const fsPath = u.fsPath;
      return {
        id: `command:${fsPath}`,
        kind: "command" as const,
        label: path.basename(fsPath, ".md"),
        fsPath,
        workspaceRelative: workspaceRelativeFor(fsPath),
        source: "workspace" as const,
        detail: fsPath,
      };
    })
    .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

export async function indexUserCommands(homeCursor: string): Promise<CatalogItem[]> {
  const dir = path.join(homeCursor, "commands");
  const files = await walkFiles(dir, (abs, name) => name.endsWith(".md"));
  return files.map((fsPath) => ({
    id: `command:${fsPath}`,
    kind: "command" as const,
    label: path.basename(fsPath, ".md"),
    fsPath,
    workspaceRelative: workspaceRelativeFor(fsPath),
    source: "user" as const,
    detail: fsPath,
  }));
}
