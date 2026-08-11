import * as path from "path";

/**
 * True when the path is under a workspace-root `.cursor/` directory
 * (e.g. `<repo>/.cursor/sre-orchestrator/fix/a.mmd`), not a nested
 * `apps/web/.cursor/…`.
 */
export function isUnderCursorDir(fsPath: string, workspaceRoots: string[] = []): boolean {
  const normalized = fsPath.replaceAll("\\", "/");
  if (workspaceRoots.length > 0) {
    return workspaceRoots.some((root) => {
      const rootNorm = root.replaceAll("\\", "/").replace(/\/$/, "");
      return normalized.startsWith(`${rootNorm}/.cursor/`);
    });
  }
  // Fallback without roots: only treat as under .cursor when the first
  // directory segment is `.cursor` (relative) or the path ends with `/.cursor/…`
  // after an arbitrary absolute prefix that is the workspace root — use the
  // last `/.cursor/` only when it is preceded by a single root-like path.
  // Prefer callers that pass workspaceRoots.
  return /(^|\/)\.cursor\//.test(normalized) && !/\/[^/]+\/\.cursor\//.test(
    normalized.replace(/^\/+/, "/"),
  );
}

/** Prefer shorter paths under `.cursor` packs; stable sort key. */
export function workflowSortKey(fsPath: string, workspaceRoots: string[] = []): string {
  const normalized = fsPath.replaceAll("\\", "/");
  const under = isUnderCursorDir(normalized, workspaceRoots) ? "0" : "1";
  return `${under}:${normalized.toLowerCase()}`;
}

export function sortWorkflowPaths(paths: string[], workspaceRoots: string[] = []): string[] {
  return [...paths].sort((a, b) =>
    workflowSortKey(a, workspaceRoots).localeCompare(workflowSortKey(b, workspaceRoots)),
  );
}

/** Display label relative to a workspace root when possible. */
export function workflowLabel(fsPath: string, workspaceRoots: string[]): string {
  const normalized = fsPath.replaceAll("\\", "/");
  for (const root of workspaceRoots) {
    const rootNorm = root.replaceAll("\\", "/").replace(/\/$/, "");
    if (normalized === rootNorm || normalized.startsWith(rootNorm + "/")) {
      return normalized.slice(rootNorm.length + 1);
    }
  }
  return path.basename(fsPath);
}

/**
 * Glob patterns that find installed Cursor workflow graphs.
 * Workspace-root `.cursor/` only (VS Code resolves relative to each folder).
 */
export const CURSOR_WORKFLOW_GLOBS = [".cursor/**/*.mmd"] as const;

export const ALL_WORKFLOW_GLOBS = [".cursor/**/*.mmd", "**/*.mmd"] as const;
