import * as esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "media", "beautiful-mermaid.js");

await mkdir(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "scripts", "beautiful-mermaid-entry.mjs")],
  bundle: true,
  format: "iife",
  globalName: "BeautifulMermaid",
  platform: "browser",
  target: ["es2020"],
  outfile,
  logLevel: "info",
  // elkjs resolves web-worker → real Worker in browsers; that breaks
  // beautiful-mermaid's sync FakeWorker layout bypass under webview CSP.
  alias: {
    "web-worker": join(root, "scripts", "empty-web-worker.mjs"),
  },
});
