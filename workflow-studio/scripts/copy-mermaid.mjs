import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "media", "mermaid.min.js");

await mkdir(dirname(destination), { recursive: true });
await copyFile(join(root, "node_modules", "mermaid", "dist", "mermaid.min.js"), destination);
