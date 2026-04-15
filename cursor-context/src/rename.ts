import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { CatalogItem } from "./types";

function homeCursorDir(): string {
  return path.join(os.homedir(), ".cursor");
}

/** Paths we are allowed to rename (workspace tree or ~/.cursor). */
function pathRootFor(absPath: string): string | undefined {
  const norm = path.normalize(absPath);
  const hc = path.normalize(homeCursorDir());
  if (norm === hc || norm.startsWith(hc + path.sep)) {
    return hc;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const base = path.normalize(folder.uri.fsPath);
    if (norm === base || norm.startsWith(base + path.sep)) {
      return base;
    }
  }
  return undefined;
}

function assertUnderSameRoot(oldPath: string, newPath: string): void {
  const root = pathRootFor(oldPath);
  if (!root) {
    throw new Error("This path is not under the workspace or ~/.cursor.");
  }
  const n = path.normalize(newPath);
  if (n !== root && !n.startsWith(root + path.sep)) {
    throw new Error("Renamed path would leave the allowed root.");
  }
}

function assertSafeBasename(name: string): void {
  if (!name || name === "." || name === "..") {
    throw new Error("Invalid name.");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("Use a file name only (no path separators).");
  }
}

async function renameOnDisk(oldPath: string, newPath: string): Promise<void> {
  assertUnderSameRoot(oldPath, newPath);
  assertUnderSameRoot(newPath, newPath);
  if (oldPath === newPath) {
    return;
  }
  try {
    await vscode.workspace.fs.rename(vscode.Uri.file(oldPath), vscode.Uri.file(newPath), { overwrite: false });
  } catch {
    await fs.rename(oldPath, newPath);
  }
}

async function renameMcpServer(fsPath: string, oldId: string, newId: string): Promise<void> {
  assertUnderSameRoot(fsPath, fsPath);
  const trimmed = newId.trim();
  if (!trimmed || trimmed === oldId) {
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error("Server id may only contain letters, numbers, underscores, and hyphens.");
  }
  const raw = await fs.readFile(fsPath, "utf8");
  const data = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
  const servers = data.mcpServers;
  if (!servers || typeof servers !== "object") {
    throw new Error("mcp.json has no mcpServers object.");
  }
  if (!(oldId in servers)) {
    throw new Error(`Server "${oldId}" not found in mcp.json.`);
  }
  if (trimmed in servers) {
    throw new Error(`Server id "${trimmed}" already exists.`);
  }
  servers[trimmed] = servers[oldId];
  delete servers[oldId];
  const next = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(fsPath, next, "utf8");
}

function isSkillSkillMd(fsPath: string): boolean {
  return path.basename(fsPath).toLowerCase() === "skill.md";
}

/**
 * Apply a title rename from the webview (file / folder rename, or MCP server id change).
 * `currentTitle` is the editable title shown in the panel (server id for MCP, basename or label for files).
 */
export async function applyTitleRename(item: Pick<CatalogItem, "kind" | "fsPath" | "label">, currentTitle: string, newTitleRaw: string): Promise<void> {
  const next = newTitleRaw.trim();
  if (!next || next === currentTitle) {
    return;
  }

  switch (item.kind) {
    case "hookManifest":
    case "legacy":
      throw new Error("This entry cannot be renamed from the panel.");

    case "mcp":
      await renameMcpServer(item.fsPath, currentTitle, next);
      return;

    case "command":
    case "cursorAgents": {
      assertSafeBasename(next);
      const base = next.toLowerCase().endsWith(".md") ? next : `${next}.md`;
      const dir = path.dirname(item.fsPath);
      const target = path.join(dir, base);
      await renameOnDisk(item.fsPath, target);
      return;
    }

    case "agents": {
      assertSafeBasename(next);
      const dir = path.dirname(item.fsPath);
      const target = path.join(dir, next);
      await renameOnDisk(item.fsPath, target);
      return;
    }

    case "rule":
    case "hook": {
      assertSafeBasename(next);
      const oldExt = path.extname(item.fsPath);
      const ext = path.extname(next) || oldExt;
      if (item.kind === "rule" && ext !== ".md" && ext !== ".mdc") {
        throw new Error("Rules must use .md or .mdc extension.");
      }
      const withExt = path.extname(next) ? next : `${next}${oldExt || ""}`;
      const dir = path.dirname(item.fsPath);
      const target = path.join(dir, withExt);
      await renameOnDisk(item.fsPath, target);
      return;
    }

    case "skill": {
      assertSafeBasename(next);
      if (isSkillSkillMd(item.fsPath)) {
        const parent = path.dirname(item.fsPath);
        const grand = path.dirname(parent);
        const targetDir = path.join(grand, next);
        await renameOnDisk(parent, targetDir);
        return;
      }
      const oldExt = path.extname(item.fsPath);
      const withExt = path.extname(next) ? next : `${next}${oldExt || ".md"}`;
      const dir = path.dirname(item.fsPath);
      const target = path.join(dir, withExt);
      await renameOnDisk(item.fsPath, target);
      return;
    }

    default: {
      const _k: never = item.kind;
      throw new Error(`Unsupported kind: ${String(_k)}`);
    }
  }
}

export function canRenameTitle(item: Pick<CatalogItem, "kind" | "label" | "fsPath" | "detail">): boolean {
  if (item.kind === "hookManifest" || item.kind === "legacy") {
    return false;
  }
  if (item.kind !== "mcp") {
    return item.kind === "rule" || item.kind === "command" || item.kind === "skill" || item.kind === "hook" || item.kind === "cursorAgents" || item.kind === "agents";
  }
  const base = path.basename(item.fsPath);
  if (item.label === base) {
    return false;
  }
  const d = item.detail ?? "";
  if (d.startsWith("Invalid JSON") || d.includes("No mcpServers object")) {
    return false;
  }
  return true;
}
