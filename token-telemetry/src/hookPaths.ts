import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Installed copy under ~/.cursor/hooks, else extension bundle. */
export function resolveHookScript(
  extensionPath: string,
  scriptBasename: string
): string {
  const user = path.join(os.homedir(), ".cursor", "hooks", scriptBasename);
  if (fs.existsSync(user)) {
    return user;
  }
  return path.join(extensionPath, "bundled", "hooks", scriptBasename);
}

/** hooks.json uses `./hooks/…`; cwd must be ~/.cursor when that dir exists. */
export function hookExecCwd(scriptPath: string): string {
  const hooksDir = path.join(os.homedir(), ".cursor", "hooks");
  return fs.existsSync(hooksDir) ? hooksDir : path.dirname(scriptPath);
}
