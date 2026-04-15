import * as path from "path";
import * as vscode from "vscode";
import type { CatalogItem } from "../types";
import { workspaceRelativeFor } from "../workspacePaths";

export async function indexAgentsMd(): Promise<CatalogItem[]> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }
  const uris = await vscode.workspace.findFiles("**/AGENTS.md", "**/node_modules/**", 500);
  const items: CatalogItem[] = [];
  for (const uri of uris) {
    const fsPath = uri.fsPath;
    items.push({
      id: `agents:${fsPath}`,
      kind: "agents",
      label: path.basename(fsPath),
      fsPath,
      workspaceRelative: workspaceRelativeFor(fsPath),
      source: "workspace",
      detail: fsPath,
    });
  }
  return items.sort((a, b) => (a.workspaceRelative ?? a.fsPath).localeCompare(b.workspaceRelative ?? b.fsPath));
}
