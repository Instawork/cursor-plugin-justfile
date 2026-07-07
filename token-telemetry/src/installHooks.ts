import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

const HOOK_BINDINGS = [
  {
    events: ["stop", "subagentStop", "preCompact"] as const,
    command: "python3 ./hooks/token_count_hook.py",
    match: "token_count_hook",
  },
] as const;

const BUNDLED_FILES = [
  "token_count_hook.py",
  "token_telemetry_db.py",
  "model_pricing.py",
  "cursor-model-rates.json",
  "token-telemetry-dashboard.tpl.html",
] as const;

type HooksDoc = {
  version?: number;
  hooks?: Record<string, { command: string }[]>;
};

export function hookPythonBin(): string {
  for (const bin of ["python3.12", "python3.11", "python3"]) {
    try {
      execSync(`${bin} -c "import tomllib"`, { stdio: "ignore" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return "python3";
}

export function hooksInstalled(): boolean {
  const hooksDir = path.join(os.homedir(), ".cursor", "hooks");
  const hookPy = path.join(hooksDir, "token_count_hook.py");
  return fs.existsSync(hookPy);
}

export function ensureDataDir(): string {
  const dir = path.join(os.homedir(), "code/cursor-contexts/assistant");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function installHooks(extensionPath: string): {
  copied: string[];
  hooksJsonPath: string;
} {
  const bundledDir = path.join(extensionPath, "bundled", "hooks");
  const hooksDir = path.join(os.homedir(), ".cursor", "hooks");
  const hooksJsonPath = path.join(os.homedir(), ".cursor", "hooks.json");

  fs.mkdirSync(hooksDir, { recursive: true });
  ensureDataDir();

  const copied: string[] = [];
  for (const name of BUNDLED_FILES) {
    const src = path.join(bundledDir, name);
    const dest = path.join(hooksDir, name);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing bundled hook file: ${name}`);
    }
    fs.copyFileSync(src, dest);
    if (name.endsWith(".py")) {
      fs.chmodSync(dest, 0o755);
    }
    copied.push(dest);
  }

  let doc: HooksDoc = { version: 1, hooks: {} };
  if (fs.existsSync(hooksJsonPath)) {
    doc = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8")) as HooksDoc;
  }
  if (!doc.hooks) {
    doc.hooks = {};
  }
  if (doc.version === undefined) {
    doc.version = 1;
  }

  const py = hookPythonBin();

  for (const binding of HOOK_BINDINGS) {
    for (const event of binding.events) {
      const list: { command: string }[] = doc.hooks[event] ?? [];
      const command = `${py} ./hooks/${binding.match}.py`;
      const idx = list.findIndex((e: { command: string }) =>
        e.command.includes(binding.match)
      );
      if (idx >= 0) {
        list[idx] = { command };
      } else {
        list.push({ command });
      }
      doc.hooks[event] = list;
    }
  }

  fs.writeFileSync(hooksJsonPath, JSON.stringify(doc, null, 4) + "\n", "utf8");

  return { copied, hooksJsonPath };
}
