import * as fs from "fs/promises";

/** Read optional `description:` from YAML-ish frontmatter (first --- block). */
export async function readMdcDescriptionHint(fsPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(fsPath, "utf8");
    const head = raw.slice(0, 8000);
    if (!head.startsWith("---")) {
      return undefined;
    }
    const end = head.indexOf("\n---", 3);
    const fm = end >= 0 ? head.slice(3, end) : head.slice(3);
    const m = fm.match(/^\s*description:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m);
    if (m) {
      return (m[1] ?? m[2] ?? m[3] ?? "").trim() || undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}
