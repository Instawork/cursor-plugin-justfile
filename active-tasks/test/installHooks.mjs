#!/usr/bin/env node
/**
 * Unit tests for installHooks (no VS Code host).
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(new URL("../package.json", import.meta.url));
const root = join(import.meta.dirname, "..");
const modPath = join(root, "out/installHooks.js");

function loadInstallHooks() {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

test("hooksInstalled returns a boolean against the live home", () => {
  const { hooksInstalled } = loadInstallHooks();
  assert.equal(typeof hooksInstalled(), "boolean");
});

test("hooksInstalled is false when only a legacy session_* hook is bound", () => {
  const home = mkdtempSync(join(tmpdir(), "at-hooks-legacy-"));
  const cursorDir = join(home, ".cursor");
  const hooksDir = join(cursorDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "active_tasks_hook.py"), "#!/usr/bin/env python3\n");
  writeFileSync(
    join(cursorDir, "hooks.json"),
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          { command: "python3 ./hooks/session_active_tasks_hook.py" },
        ],
        afterAgentResponse: [
          { command: "python3 ./hooks/session_active_tasks_hook.py" },
        ],
      },
    })
  );
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { hooksInstalled } = loadInstallHooks();
    assert.equal(hooksInstalled(), false);
  } finally {
    process.env.HOME = prevHome;
    loadInstallHooks();
    rmSync(home, { recursive: true, force: true });
  }
});

test("installHooks writes both events and drops legacy Active Tasks injectors", () => {
  const home = mkdtempSync(join(tmpdir(), "at-hooks-home-"));
  const extensionPath = mkdtempSync(join(tmpdir(), "at-hooks-ext-"));
  const cursorDir = join(home, ".cursor");
  const hooksDir = join(cursorDir, "hooks");
  const bundled = join(extensionPath, "bundled", "hooks");
  mkdirSync(bundled, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(bundled, "active_tasks_hook.py"),
    "#!/usr/bin/env python3\nprint('{}')\n"
  );
  writeFileSync(join(hooksDir, "session_active_tasks_hook.py"), "# legacy\n");
  writeFileSync(
    join(cursorDir, "hooks.json"),
    JSON.stringify(
      {
        version: 1,
        hooks: {
          sessionStart: [
            { command: "python3 ./hooks/session_active_tasks_hook.py" },
            { command: "python3 ./hooks/session_open_work_hook.py" },
          ],
        },
      },
      null,
      4
    )
  );

  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { installHooks, hooksInstalled } = loadInstallHooks();
    installHooks(extensionPath);
    assert.ok(existsSync(join(hooksDir, "active_tasks_hook.py")));
    assert.ok(!existsSync(join(hooksDir, "session_active_tasks_hook.py")));
    const doc = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8"));
    const ss = (doc.hooks.sessionStart || []).map((e) => e.command);
    const aar = (doc.hooks.afterAgentResponse || []).map((e) => e.command);
    assert.ok(ss.some((c) => c.includes("./hooks/active_tasks_hook.py")));
    assert.equal(ss.filter((c) => c.includes("session_active_tasks")).length, 0);
    assert.equal(ss.filter((c) => c.includes("session_open_work")).length, 0);
    assert.ok(aar.some((c) => c.includes("./hooks/active_tasks_hook.py")));
    assert.equal(hooksInstalled(), true);
  } finally {
    process.env.HOME = prevHome;
    loadInstallHooks();
    rmSync(home, { recursive: true, force: true });
    rmSync(extensionPath, { recursive: true, force: true });
  }
});
