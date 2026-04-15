import * as path from "path";
import * as vscode from "vscode";
import { readMdcDescriptionHint } from "../frontmatter";
import type { CatalogItem } from "../types";
import { walkFiles } from "../fsutil";
import { workspaceRelativeFor } from "../workspacePaths";

const FIND_EXCLUDE = "**/{node_modules,.git,dist,out,target}/**";

async function fileToRuleItem(fsPath: string, source: "workspace" | "user"): Promise<CatalogItem> {
  const desc = await readMdcDescriptionHint(fsPath);
  const base = path.basename(fsPath);
  const label = desc ? `${base} — ${desc}` : base;
  return {
    id: `rule:${fsPath}`,
    kind: "rule",
    label,
    fsPath,
    workspaceRelative: workspaceRelativeFor(fsPath),
    source,
    detail: fsPath,
  };
}

export async function indexWorkspaceRules(): Promise<CatalogItem[]> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }
  const md = await vscode.workspace.findFiles("**/.cursor/rules/**/*.md", FIND_EXCLUDE, 500);
  const mdc = await vscode.workspace.findFiles("**/.cursor/rules/**/*.mdc", FIND_EXCLUDE, 500);
  const seen = new Set<string>();
  const uris = [...md, ...mdc].filter((u) => {
    const p = u.fsPath;
    if (seen.has(p)) {
      return false;
    }
    seen.add(p);
    return true;
  });
  const items: CatalogItem[] = [];
  for (const u of uris) {
    items.push(await fileToRuleItem(u.fsPath, "workspace"));
  }
  return items.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

export async function indexUserRules(homeCursor: string): Promise<CatalogItem[]> {
  const dir = path.join(homeCursor, "rules");
  const files = await walkFiles(
    dir,
    (abs, name) => name.endsWith(".mdc") || name.endsWith(".md"),
  );
  const items: CatalogItem[] = [];
  for (const fsPath of files) {
    items.push(await fileToRuleItem(fsPath, "user"));
  }
  return items;
}
