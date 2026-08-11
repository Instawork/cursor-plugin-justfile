import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

const HOOK_STEM = "active_tasks_hook";

const HOOK_BINDINGS = [
  {
    events: ["sessionStart", "afterAgentResponse"] as const,
    match: HOOK_STEM,
  },
] as const;

const BUNDLED_FILES = [`${HOOK_STEM}.py`] as const;

type HookEntry = { command: string; timeout?: number; matcher?: string };

type HooksDoc = {
  version?: number;
  hooks?: Record<string, HookEntry[]>;
};

function hookPythonBin(): string {
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

function hooksJsonPath(): string {
  return path.join(os.homedir(), ".cursor", "hooks.json");
}

function hooksDir(): string {
  return path.join(os.homedir(), ".cursor", "hooks");
}

function readHooksDoc(hooksJson: string): HooksDoc {
  if (!fs.existsSync(hooksJson)) {
    return { version: 1, hooks: {} };
  }
  return JSON.parse(fs.readFileSync(hooksJson, "utf8")) as HooksDoc;
}

function bindingsPresent(doc: HooksDoc, match: string): boolean {
  const hooks = doc.hooks ?? {};
  const needle = `./hooks/${match}.py`;
  for (const binding of HOOK_BINDINGS) {
    for (const event of binding.events) {
      const list = hooks[event] ?? [];
      if (!list.some((e) => (e.command || "").includes(needle))) {
        return false;
      }
    }
  }
  return true;
}

/** True when the one Active Tasks hook file and hooks.json bindings are in place. */
export function hooksInstalled(): boolean {
  const hookPy = path.join(hooksDir(), `${HOOK_STEM}.py`);
  if (!fs.existsSync(hookPy)) {
    return false;
  }
  try {
    return bindingsPresent(readHooksDoc(hooksJsonPath()), HOOK_STEM);
  } catch {
    return false;
  }
}

export function installHooks(extensionPath: string): {
  copied: string[];
  hooksJsonPath: string;
} {
  const bundledDir = path.join(extensionPath, "bundled", "hooks");
  const destDir = hooksDir();
  const jsonPath = hooksJsonPath();

  fs.mkdirSync(destDir, { recursive: true });

  const copied: string[] = [];
  for (const name of BUNDLED_FILES) {
    const src = path.join(bundledDir, name);
    const dest = path.join(destDir, name);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing bundled hook file: ${name}`);
    }
    fs.copyFileSync(src, dest);
    if (name.endsWith(".py")) {
      fs.chmodSync(dest, 0o755);
    }
    copied.push(dest);
  }

  // Drop legacy forks if a prior install left them behind.
  for (const legacy of [
    "session_active_tasks_hook.py",
    "active_tasks_db.py",
    "session_open_work_hook.py",
  ]) {
    const legacyPath = path.join(destDir, legacy);
    if (fs.existsSync(legacyPath)) {
      try {
        fs.unlinkSync(legacyPath);
      } catch {
        /* ignore */
      }
    }
  }

  const doc = readHooksDoc(jsonPath);
  if (!doc.hooks) {
    doc.hooks = {};
  }
  if (doc.version === undefined) {
    doc.version = 1;
  }

  const py = hookPythonBin();
  const command = `${py} ./hooks/${HOOK_STEM}.py`;

  for (const binding of HOOK_BINDINGS) {
    for (const event of binding.events) {
      const list: HookEntry[] = [...(doc.hooks[event] ?? [])];
      // Remove legacy Active Tasks / open-work injectors from this event.
      const cleaned = list.filter((e) => {
        const c = e.command || "";
        // HOOK_STEM is a substring of session_active_tasks_hook; one check covers both.
        return !c.includes("session_open_work_hook") && !c.includes(HOOK_STEM);
      });
      cleaned.push({ command });
      doc.hooks[event] = cleaned;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 4) + "\n", "utf8");

  return { copied, hooksJsonPath: jsonPath };
}
