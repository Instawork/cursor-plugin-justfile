import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const JUST_IO = { maxBuffer: 10 * 1024 * 1024 } as const;

function justExecOptions(cwd: string, env: NodeJS.ProcessEnv) {
  return { cwd, env, maxBuffer: JUST_IO.maxBuffer };
}

const VIEW_ID = "justfile-runner.panel";

const PINS_STATE_KEY = "justfileRunner.pinnedRecipesByCwd";

const SAVED_STATE_KEY = "justfileRunner.savedCommandsByCwd";

type SavedCommand = { id: string; recipe: string; args: string };

function readCwdBucket<T>(memento: vscode.Memento, key: string, cwd: string): T[] {
  const raw = memento.get<Record<string, T[]>>(key, {});
  return raw[cwd] ?? [];
}

async function writeCwdBucket<T>(memento: vscode.Memento, key: string, cwd: string, value: T[]): Promise<void> {
  const raw = { ...memento.get<Record<string, T[]>>(key, {}) };
  if (value.length === 0) {
    delete raw[cwd];
  } else {
    raw[cwd] = value;
  }
  await memento.update(key, raw);
}

function execEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(process.env.HOME ?? "", ".local", "bin")];
  const current = env.PATH ?? "";
  env.PATH = [...extra.filter((p) => p && fs.existsSync(p)), current].join(path.delimiter);
  return env;
}

function parseSummaryRecipes(stdout: string): string[] {
  return stripAnsi(stdout)
    .split(/\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

type RecipeEntry = { name: string; acceptsArgs: boolean };

type RecipeGroup = { label: string; recipes: RecipeEntry[] };

function restBeforeComment(s: string): string {
  const hash = s.indexOf("#");
  return (hash >= 0 ? s.slice(0, hash) : s).trim();
}

function hasParametersInListLine(afterRecipeToken: string): boolean {
  let s = restBeforeComment(afterRecipeToken);
  s = s.replace(/\s*\[alias:[^\]]*]\s*$/i, "").trim();
  return s.length > 0;
}

function buildArgHintsFromJustDump(data: unknown): Record<string, boolean> | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const root = data as Record<string, unknown>;
  const recipes = root.recipes;
  if (!recipes || typeof recipes !== "object") {
    return null;
  }
  const hints: Record<string, boolean> = {};
  for (const [name, rec] of Object.entries(recipes as Record<string, { parameters?: unknown[] }>)) {
    const params = rec?.parameters;
    hints[name] = Array.isArray(params) && params.length > 0;
  }
  const aliases = root.aliases;
  if (aliases && typeof aliases === "object") {
    for (const [aliasName, aliasDef] of Object.entries(aliases as Record<string, { target?: string }>)) {
      const target = aliasDef?.target;
      if (target !== undefined) {
        const targetHint = hints[target];
        if (targetHint !== undefined) {
          hints[aliasName] = targetHint;
        }
      }
    }
  }
  return hints;
}

async function applyArgHintsFromJustDump(
  cwd: string,
  groups: RecipeGroup[],
  env: NodeJS.ProcessEnv,
): Promise<RecipeGroup[]> {
  try {
    const dumped = await execFileAsync("just", ["--dump", "--dump-format", "json"], justExecOptions(cwd, env));
    const hints = buildArgHintsFromJustDump(JSON.parse(dumped.stdout) as unknown);
    if (!hints) {
      return groups;
    }
    return groups.map((g) => ({
      label: g.label,
      recipes: g.recipes.map((r) => {
        const fromDump = hints[r.name];
        return {
          name: r.name,
          acceptsArgs: fromDump !== undefined ? fromDump : r.acceptsArgs,
        };
      }),
    }));
  } catch {
    return groups;
  }
}

function parseListGrouped(stdout: string): RecipeGroup[] {
  const order: string[] = [];
  const byLabel = new Map<string, RecipeEntry[]>();
  let currentLabel: string | null = null;

  const addRecipe = (label: string, entry: RecipeEntry) => {
    if (!byLabel.has(label)) {
      byLabel.set(label, []);
      order.push(label);
    }
    const bucket = byLabel.get(label)!;
    if (!bucket.some((r) => r.name === entry.name)) {
      bucket.push(entry);
    }
  };

  for (const rawLine of stripAnsi(stdout).split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }
    const t = line.trim();
    if (t === "Available recipes:" || t.startsWith("error:")) {
      continue;
    }
    const groupMatch = t.match(/^\[([^\]]+)\]$/);
    if (groupMatch) {
      currentLabel = groupMatch[1] ?? "Other";
      continue;
    }
    const m = line.match(/^\s+(\S+)/);
    if (!m || m.index === undefined) {
      continue;
    }
    const name = m[1];
    if (name.startsWith("[")) {
      continue;
    }
    const afterName = line.slice(m.index + m[0].length);
    const acceptsArgs = hasParametersInListLine(afterName);
    addRecipe(currentLabel ?? "Other", { name, acceptsArgs });
  }

  return order.map((label) => ({ label, recipes: byLabel.get(label) ?? [] }));
}

function totalNamesInGroups(groups: RecipeGroup[]): number {
  return groups.reduce((n, g) => n + g.recipes.length, 0);
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function shellQuoteArg(arg: string): string {
  if (/^[\w@%+=.,:/-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function buildJustCommandLine(recipe: string, args: string): string {
  const tail = args.trim();
  return tail.length > 0 ? `just ${shellQuoteArg(recipe)} ${tail}` : `just ${shellQuoteArg(recipe)}`;
}

function findJustfileCwdFromPath(startFsPath: string): string | undefined {
  let dir = path.dirname(startFsPath);
  const { root } = path.parse(dir);
  while (true) {
    for (const name of ["justfile", "Justfile"]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        return dir;
      }
    }
    if (dir === root) {
      break;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

function firstWorkspaceJustfileCwd(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const base = folder.uri.fsPath;
    for (const name of ["justfile", "Justfile"]) {
      if (fs.existsSync(path.join(base, name))) {
        return base;
      }
    }
  }
  return undefined;
}

function resolveJustCwd(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") {
    const fromEditor = findJustfileCwdFromPath(active.fsPath);
    if (fromEditor) {
      return fromEditor;
    }
  }
  return firstWorkspaceJustfileCwd();
}

async function listRecipes(cwd: string): Promise<{ groups: RecipeGroup[]; error?: string }> {
  const env = {
    ...execEnv(),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  try {
    const listed = await execFileAsync("just", ["--list", "--unsorted"], justExecOptions(cwd, env));
    let groups = parseListGrouped(listed.stdout);
    if (totalNamesInGroups(groups) === 0) {
      const { stdout } = await execFileAsync("just", ["--summary", "--unsorted"], justExecOptions(cwd, env));
      const names = parseSummaryRecipes(stdout);
      groups =
        names.length > 0
          ? [{ label: "Recipes", recipes: names.map((name) => ({ name, acceptsArgs: true })) }]
          : [];
    }
    groups = await applyArgHintsFromJustDump(cwd, groups, env);
    return { groups };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { groups: [], error: msg };
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function buildWebviewHtml(webview: vscode.Webview, extensionRoot: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
  ].join("; ");
  const panelPath = path.join(extensionRoot.fsPath, "media", "panel.html");
  const template = fs.readFileSync(panelPath, "utf8");
  return template.replaceAll("__NONCE__", nonce).replaceAll("__CSP__", escapeHtmlAttribute(csp));
}

class JustfileRunnerViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getPinsForCwd(cwd: string): string[] {
    return readCwdBucket<string>(this.context.workspaceState, PINS_STATE_KEY, cwd);
  }

  private setPinsForCwd(cwd: string, pins: string[]): Promise<void> {
    return writeCwdBucket(this.context.workspaceState, PINS_STATE_KEY, cwd, pins);
  }

  private async togglePinForCwd(cwd: string, recipe: string): Promise<void> {
    const pins = [...this.getPinsForCwd(cwd)];
    const i = pins.indexOf(recipe);
    if (i >= 0) {
      pins.splice(i, 1);
    } else {
      pins.unshift(recipe);
    }
    await this.setPinsForCwd(cwd, pins);
  }

  private getSavedForCwd(cwd: string): SavedCommand[] {
    return readCwdBucket<SavedCommand>(this.context.workspaceState, SAVED_STATE_KEY, cwd);
  }

  private setSavedForCwd(cwd: string, list: SavedCommand[]): Promise<void> {
    return writeCwdBucket(this.context.workspaceState, SAVED_STATE_KEY, cwd, list);
  }

  private async addSavedCommand(cwd: string, recipe: string, args: string): Promise<void> {
    const list = [...this.getSavedForCwd(cwd)];
    list.unshift({ id: crypto.randomUUID(), recipe, args: args.trim() });
    await this.setSavedForCwd(cwd, list);
  }

  private async deleteSavedById(cwd: string, id: string): Promise<void> {
    const list = this.getSavedForCwd(cwd).filter((s) => s.id !== id);
    await this.setSavedForCwd(cwd, list);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") {
        await this.pushRecipes();
        return;
      }
      if (msg?.type === "togglePin" && typeof msg.recipe === "string") {
        const cwd = resolveJustCwd();
        if (!cwd) {
          return;
        }
        await this.togglePinForCwd(cwd, msg.recipe as string);
        await this.pushRecipes();
        return;
      }
      if (msg?.type === "saveRun" && typeof msg.recipe === "string") {
        const cwd = resolveJustCwd();
        if (!cwd) {
          return;
        }
        const args = typeof msg.args === "string" ? msg.args : "";
        await this.addSavedCommand(cwd, msg.recipe as string, args);
        await this.pushRecipes();
        return;
      }
      if (msg?.type === "deleteSaved" && typeof msg.id === "string") {
        const cwd = resolveJustCwd();
        if (!cwd) {
          return;
        }
        await this.deleteSavedById(cwd, msg.id as string);
        await this.pushRecipes();
        return;
      }
      if (msg?.type === "run" && typeof msg.recipe === "string") {
        const cwd = resolveJustCwd();
        if (!cwd) {
          void vscode.window.showErrorMessage("No justfile found in this workspace.");
          return;
        }
        const recipe = msg.recipe as string;
        const args = typeof msg.args === "string" ? msg.args : "";
        const term = vscode.window.createTerminal({
          name: `just ${recipe}`,
          cwd,
        });
        term.show();
        term.sendText(buildJustCommandLine(recipe, args), true);
      }
    });

    webviewView.webview.html = buildWebviewHtml(webviewView.webview, this.context.extensionUri);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.pushRecipes();
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  async refresh(): Promise<void> {
    await this.pushRecipes();
  }

  private async pushRecipes(): Promise<void> {
    if (!this.view) {
      return;
    }
    const cwd = resolveJustCwd();
    if (!cwd) {
      this.view.webview.postMessage({
        type: "recipes",
        pinned: [],
        saved: [],
        groups: [],
        argHints: {},
        cwd: "",
        error: "No justfile or Justfile found. Open a folder that contains one.",
        recipeCount: 0,
      });
      return;
    }
    const { groups, error } = await listRecipes(cwd);
    const recipeCount = totalNamesInGroups(groups);
    let storedPins = this.getPinsForCwd(cwd);
    const allNames = new Set(groups.flatMap((g) => g.recipes.map((r) => r.name)));
    const argHints = Object.fromEntries(groups.flatMap((g) => g.recipes.map((r) => [r.name, r.acceptsArgs])));
    const orderedPins = storedPins.filter((n) => allNames.has(n));
    if (orderedPins.length !== storedPins.length) {
      await this.setPinsForCwd(cwd, orderedPins);
    }
    let storedSaved = this.getSavedForCwd(cwd);
    const prunedSaved = storedSaved.filter((s) => allNames.has(s.recipe));
    if (prunedSaved.length !== storedSaved.length) {
      await this.setSavedForCwd(cwd, prunedSaved);
    }
    const pinSet = new Set(orderedPins);
    const filteredGroups = groups
      .map((g) => ({
        label: g.label,
        recipes: g.recipes
          .filter((r) => !pinSet.has(r.name))
          .map((r) => ({ name: r.name, acceptsArgs: r.acceptsArgs })),
      }))
      .filter((g) => g.recipes.length > 0);
    this.view.webview.postMessage({
      type: "recipes",
      pinned: orderedPins,
      saved: prunedSaved,
      groups: filteredGroups,
      argHints,
      cwd,
      error: error ?? "",
      recipeCount,
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new JustfileRunnerViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand("justfileRunner.refresh", () => provider.refresh()),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void provider.refresh();
    }),
  );

  if (vscode.workspace.workspaceFolders?.length) {
    const onJustfileFsChange = () => {
      void provider.refresh();
    };
    for (const folder of vscode.workspace.workspaceFolders) {
      const pattern = new vscode.RelativePattern(folder, "{justfile,Justfile}");
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      w.onDidChange(onJustfileFsChange);
      w.onDidCreate(onJustfileFsChange);
      w.onDidDelete(onJustfileFsChange);
      context.subscriptions.push(w);
    }
  }
}
