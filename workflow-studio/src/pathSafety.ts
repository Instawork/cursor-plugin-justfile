import * as fs from "fs/promises";
import * as path from "path";

export const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

export interface PathSafetyResult {
  safe: boolean;
  targetPath?: string;
  exists: boolean;
  reason?: string;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function forbiddenReason(relativePath: string): string | undefined {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.startsWith(".env"))) {
    return "Environment files cannot be opened in Workflow Studio.";
  }
  if (segments.some((segment) => segment.includes("secret"))) {
    return "Secret-bearing paths cannot be opened in Workflow Studio.";
  }
  if (normalized === "src/config/local.py" || normalized.endsWith("/src/config/local.py")) {
    return "src/config/local.py cannot be opened in Workflow Studio.";
  }
  return undefined;
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

export async function resolvePromptTarget(
  diagramPath: string,
  relativePath: string,
  workspaceRoots: string[],
): Promise<PathSafetyResult> {
  if (path.isAbsolute(relativePath)) {
    return { safe: false, exists: false, reason: "Prompt path must be relative to the workflow file." };
  }
  const blocked = forbiddenReason(relativePath);
  if (blocked) {
    return { safe: false, exists: false, reason: blocked };
  }

  const diagramDirRaw = path.dirname(diagramPath);
  let diagramDir = diagramDirRaw;
  try {
    diagramDir = await fs.realpath(diagramDirRaw);
  } catch {
    diagramDir = path.resolve(diagramDirRaw);
  }
  const targetPath = path.resolve(diagramDir, relativePath);
  const roots = await Promise.all(
    workspaceRoots.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
  const lexicalRoot = roots.find((root) => isInside(root, targetPath));
  if (!lexicalRoot) {
    return {
      safe: false,
      exists: false,
      reason: "Prompt path must stay inside an open workspace folder.",
    };
  }

  try {
    const stat = await fs.lstat(targetPath);
    const realTarget = await fs.realpath(targetPath);
    if (!roots.some((root) => isInside(root, realTarget))) {
      return {
        safe: false,
        exists: true,
        reason: "Prompt path resolves outside the open workspace through a symbolic link.",
      };
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return { safe: false, exists: true, reason: "Prompt path does not point to a file." };
    }
    return { safe: true, targetPath, exists: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { safe: false, exists: false, reason: "Prompt path could not be inspected safely." };
    }
  }

  const ancestor = await nearestExistingAncestor(path.dirname(targetPath));
  const realAncestor = await fs.realpath(ancestor);
  if (!roots.some((root) => isInside(root, realAncestor))) {
    return {
      safe: false,
      exists: false,
      reason: "Prompt path would escape the open workspace through a symbolic link.",
    };
  }
  if (ancestor !== path.dirname(targetPath)) {
    return {
      safe: false,
      exists: false,
      reason: "Prompt directory does not exist. Create it, then select the node again.",
    };
  }
  return { safe: true, targetPath, exists: false };
}
