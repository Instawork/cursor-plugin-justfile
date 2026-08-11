import * as esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "out", "beautiful-mermaid-cjs.js");

await mkdir(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "node_modules", "beautiful-mermaid", "dist", "index.js")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node18"],
  outfile,
  logLevel: "info",
  alias: {
    "web-worker": join(root, "scripts", "empty-web-worker.mjs"),
  },
});
