import * as path from "path";
import * as vscode from "vscode";

/** Best-effort workspace-relative posix path, or undefined if not under any folder. */
export function workspaceRelativeFor(fsPath: string): string | undefined {
  const norm = path.normalize(fsPath);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const base = path.normalize(folder.uri.fsPath);
    if (norm === base || norm.startsWith(base + path.sep)) {
      return path.relative(base, norm).split(path.sep).join("/");
    }
  }
  return undefined;
}
