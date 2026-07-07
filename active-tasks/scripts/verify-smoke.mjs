#!/usr/bin/env node
/** Smoke checks before packaging Active Tasks (no VS Code host). */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const requiredCommands = [
  "activeTasks.open",
  "activeTasks.popOut",
  "activeTasks.refresh",
  "activeTasks.installHooks",
];
const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
for (const id of requiredCommands) {
  if (!contributed.has(id)) {
    console.error("missing contributed command:", id);
    process.exit(1);
  }
}
for (const id of requiredCommands) {
  const ev = `onCommand:${id}`;
  if (!pkg.activationEvents.includes(ev) && !pkg.activationEvents.includes("*")) {
    console.error("missing activation event:", ev);
    process.exit(1);
  }
}

require(join(root, "out/activeTasksStore.js")).openActiveTasksDb();
readFileSync(join(root, "node_modules/bindings/package.json"), "utf8");
console.log("active-tasks smoke ok", pkg.version);
