import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { CatalogItem } from "../types";
import { pathExists } from "../fsutil";
import { workspaceRelativeFor } from "../workspacePaths";

const FIND_EXCLUDE = "**/{node_modules,.git,dist,out,target}/**";

type McpServerEntry = Record<string, unknown>;

function summarizeServer(id: string, cfg: McpServerEntry): string {
  const command = typeof cfg.command === "string" ? cfg.command : "";
  const url = typeof cfg.url === "string" ? cfg.url : "";
  const args = Array.isArray(cfg.args) ? (cfg.args as unknown[]).filter((a) => typeof a === "string").join(" ") : "";
  if (url) {
    return `${id}: url ${url}`;
  }
  if (command) {
    const tail = args ? ` ${args}` : "";
    return `${id}: ${command}${tail}`;
  }
  return `${id}: (see MCP docs)`;
}

async function parseMcpFile(fsPath: string, source: "workspace" | "user"): Promise<CatalogItem[]> {
  if (!(await pathExists(fsPath))) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(fsPath, "utf8"));
  } catch {
    return [
      {
        id: `mcp:err:${fsPath}`,
        kind: "mcp",
        label: path.basename(fsPath),
        fsPath,
        workspaceRelative: workspaceRelativeFor(fsPath),
        source,
        detail: "Invalid JSON",
      },
    ];
  }
  const items: CatalogItem[] = [];
  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers;
  if (!servers || typeof servers !== "object") {
    items.push({
      id: `mcp:file:${fsPath}`,
      kind: "mcp",
      label: path.basename(fsPath),
      fsPath,
      workspaceRelative: workspaceRelativeFor(fsPath),
      source,
      detail: "No mcpServers object (open mcp.json to inspect)",
    });
    return items;
  }
  for (const [id, raw] of Object.entries(servers as Record<string, McpServerEntry>)) {
    const cfg = raw && typeof raw === "object" ? raw : {};
    items.push({
      id: `mcp:${fsPath}:${id}`,
      kind: "mcp",
      label: id,
      fsPath,
      workspaceRelative: workspaceRelativeFor(fsPath),
      source,
      detail: summarizeServer(id, cfg),
    });
  }
  return items;
}

export async function indexWorkspaceMcp(): Promise<CatalogItem[]> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }
  const uris = await vscode.workspace.findFiles("**/.cursor/mcp.json", FIND_EXCLUDE, 50);
  const out: CatalogItem[] = [];
  for (const u of uris) {
    out.push(...(await parseMcpFile(u.fsPath, "workspace")));
  }
  return out;
}

export async function indexUserMcp(homeCursor: string): Promise<CatalogItem[]> {
  return parseMcpFile(path.join(homeCursor, "mcp.json"), "user");
}
