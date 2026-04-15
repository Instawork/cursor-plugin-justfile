import * as fs from "fs";
import * as path from "path";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles(
  rootDir: string,
  predicate: (absPath: string, name: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs);
      } else if (ent.isFile() && predicate(abs, ent.name)) {
        out.push(abs);
      }
    }
  }
  if (await pathExists(rootDir)) {
    await walk(rootDir);
  }
  return out.sort();
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
