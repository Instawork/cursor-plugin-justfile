import * as path from "path";
import * as vscode from "vscode";
import type { CatalogItem } from "../types";
import { pathExists } from "../fsutil";
import { workspaceRelativeFor } from "../workspacePaths";

export async function indexCursorrules(): Promise<CatalogItem[]> {
  const out: CatalogItem[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const fsPath = path.join(folder.uri.fsPath, ".cursorrules");
    if (await pathExists(fsPath)) {
      out.push({
        id: `legacy:${fsPath}`,
        kind: "legacy",
        label: ".cursorrules",
        fsPath,
        workspaceRelative: workspaceRelativeFor(fsPath),
        source: "workspace",
        detail: "Legacy format (Agent mode prefers .cursor/rules)",
      });
    }
  }
  return out;
}
