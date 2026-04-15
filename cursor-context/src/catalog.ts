import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { indexAgentsMd } from "./indexers/agents";
import { indexWorkspaceCommands, indexUserCommands } from "./indexers/commands";
import { indexWorkspaceHooks, indexUserHooks } from "./indexers/hooks";
import { indexWorkspaceMcp, indexUserMcp } from "./indexers/mcp";
import { indexCursorrules } from "./indexers/legacy";
import { indexWorkspaceRules, indexUserRules } from "./indexers/rules";
import { indexWorkspaceCursorAgents, indexUserCursorAgents } from "./indexers/cursorAgents";
import { indexExtraSkillRoots, indexUserSkillsDefault, indexWorkspaceSkills } from "./indexers/skills";
import type { CatalogItem, CatalogPayload } from "./types";

function homeCursorDir(): string {
  return path.join(os.homedir(), ".cursor");
}

export async function buildCatalog(): Promise<CatalogPayload> {
  const homeCursor = homeCursorDir();
  const extraSkillRoots = vscode.workspace.getConfiguration("cursor-context").get<string[]>("skillGlobs", []);

  let error: string | undefined;
  const batches: Promise<CatalogItem[]>[] = [
    indexWorkspaceRules(),
    indexUserRules(homeCursor),
    indexWorkspaceCommands(),
    indexUserCommands(homeCursor),
    indexWorkspaceCursorAgents(),
    indexUserCursorAgents(homeCursor),
    indexWorkspaceSkills(),
    indexUserSkillsDefault(homeCursor),
    indexExtraSkillRoots(extraSkillRoots),
    indexWorkspaceHooks(),
    indexUserHooks(homeCursor),
    indexWorkspaceMcp(),
    indexUserMcp(homeCursor),
    indexAgentsMd(),
    indexCursorrules(),
  ];

  const results = await Promise.allSettled(batches);
  const items: CatalogItem[] = [];
  const errs: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      items.push(...r.value);
    } else {
      errs.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  }
  if (errs.length) {
    error = errs.join("; ");
  }

  const byId = new Map<string, CatalogItem>();
  for (const it of items) {
    if (!byId.has(it.id)) {
      byId.set(it.id, it);
    }
  }
  const deduped = [...byId.values()];
  deduped.sort((a, b) => {
    const ka = `${a.kind}\0${a.fsPath}`;
    const kb = `${b.kind}\0${b.fsPath}`;
    return ka.localeCompare(kb);
  });

  return { type: "catalog", items: deduped, error, homeCursor };
}
