#!/usr/bin/env node
/**
 * Rebuild better-sqlite3 for the Electron version bundled in Cursor (extension host).
 * Dev `npm test` uses system Node; run `npm run rebuild:system` after packaging if you test locally.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function electronVersionFromCursorApp() {
  if (process.platform !== "darwin") {
    return null;
  }
  const plist =
    "/Applications/Cursor.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist";
  if (!fs.existsSync(plist)) {
    return null;
  }
  try {
    const out = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", "-o", "-", plist], {
      encoding: "utf8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function resolveElectronVersion() {
  const fromEnv = process.env.ACTIVE_TASKS_ELECTRON_VERSION?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromCursor = electronVersionFromCursorApp();
  if (fromCursor) {
    return fromCursor;
  }
  throw new Error(
    "Could not detect Cursor Electron version. Set ACTIVE_TASKS_ELECTRON_VERSION (e.g. 40.10.3)."
  );
}

const version = resolveElectronVersion();
console.log(`Rebuilding better-sqlite3 for Electron ${version}…`);

execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["@electron/rebuild", "-f", "-w", "better-sqlite3", "-v", version],
  { cwd: root, stdio: "inherit", env: process.env }
);

console.log("Native rebuild done.");
