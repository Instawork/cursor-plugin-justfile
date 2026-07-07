import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

import { getGitDecorationsForWorkspace, invalidateGitDecorationCache, type GitKind } from "./gitDecorations";

const VIEW_TYPE = "sideDock.explorerStrip";

let stripPanel: vscode.WebviewPanel | undefined;

const MAX_DIR_ENTRIES = 500;
const SKIP_NAMES = new Set([".git", "node_modules"]);
const FOLLOW_DEBOUNCE_MS = 120;

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function isUnderWorkspace(absPath: string): boolean {
  const norm = path.normalize(absPath);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = path.normalize(folder.uri.fsPath);
    if (norm === root || norm.startsWith(root + path.sep)) {
      return true;
    }
  }
  return false;
}

/** Workspace-relative key using `/` (empty string = roots). */
function resolveAbs(rel: string): string | undefined {
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }
  if (folders.length === 1) {
    const root = folders[0]!.uri.fsPath;
    return path.normalize(path.join(root, ...parts));
  }
  if (parts.length === 0) {
    return undefined;
  }
  const wf = folders.find((f) => f.name === parts[0]);
  if (!wf) {
    return undefined;
  }
  return path.normalize(path.join(wf.uri.fsPath, ...parts.slice(1)));
}

function childRelPath(relPrefix: string, name: string): string {
  const p = relPrefix.replace(/\\/g, "/");
  return p.length ? `${p}/${name}` : name;
}

/** Same path keys as the tree / `resolveAbs` (multi-root: `FolderName/rest`). */
function relPathFromFileUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== "file") {
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }
  const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
  const roots = vscode.workspace.workspaceFolders ?? [];
  if (roots.length === 1) {
    return rel;
  }
  return rel.length ? `${folder.name}/${rel}` : folder.name;
}

/** Directory prefixes to expand so `relPath` (file or folder) is reachable; includes `""`. */
function directoryPrefixesForRel(relPath: string): string[] {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length === 0) {
    return [""];
  }
  const prefixes: string[] = [""];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
    prefixes.push(acc);
  }
  return prefixes;
}

type DirRow = { name: string; relPath: string; isDirectory: boolean; icon: string; git?: GitKind };

/** Codicon class names (same font as VS Code / Explorer). */
function codiconForFileName(fileName: string, isDirectory: boolean): string {
  if (isDirectory) {
    return "codicon-folder";
  }
  const lower = fileName.toLowerCase();
  const ext = path.extname(lower);
  const base = path.basename(lower);
  const byExt: Record<string, string> = {
    ".ts": "codicon-typescript",
    ".tsx": "codicon-typescript",
    ".mts": "codicon-typescript",
    ".cts": "codicon-typescript",
    ".js": "codicon-javascript",
    ".jsx": "codicon-javascript",
    ".mjs": "codicon-javascript",
    ".cjs": "codicon-javascript",
    ".json": "codicon-json",
    ".code-workspace": "codicon-json",
    ".md": "codicon-markdown",
    ".mdx": "codicon-markdown",
    ".html": "codicon-html",
    ".htm": "codicon-html",
    ".css": "codicon-css",
    ".scss": "codicon-css",
    ".sass": "codicon-css",
    ".less": "codicon-css",
    ".py": "codicon-python",
    ".svg": "codicon-symbol-color",
    ".png": "codicon-file-media",
    ".jpg": "codicon-file-media",
    ".jpeg": "codicon-file-media",
    ".gif": "codicon-file-media",
    ".webp": "codicon-file-media",
    ".yml": "codicon-settings",
    ".yaml": "codicon-settings",
    ".toml": "codicon-settings",
    ".sh": "codicon-terminal",
    ".bash": "codicon-terminal",
    ".zsh": "codicon-terminal",
    ".zip": "codicon-archive",
    ".lock": "codicon-lock",
    ".rs": "codicon-symbol-class",
    ".go": "codicon-symbol-interface",
    ".java": "codicon-symbol-class",
    ".rb": "codicon-ruby",
    ".php": "codicon-symbol-misc",
    ".sql": "codicon-database",
    ".xml": "codicon-symbol-misc",
    ".wasm": "codicon-file-binary",
  };
  if (byExt[ext]) {
    return byExt[ext]!;
  }
  const special: Record<string, string> = {
    dockerfile: "codicon-symbol-misc",
    makefile: "codicon-tools",
    ".gitignore": "codicon-git-branch",
    ".env": "codicon-key",
    "justfile": "codicon-symbol-misc",
  };
  if (special[base]) {
    return special[base]!;
  }
  return "codicon-file";
}

async function readDirectoryRows(absDir: string, relPrefix: string, decor: Map<string, GitKind>): Promise<DirRow[]> {
  let ents;
  try {
    ents = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: DirRow[] = [];
  for (const e of ents) {
    if (SKIP_NAMES.has(e.name)) {
      continue;
    }
    const isDir = e.isDirectory();
    const relPath = childRelPath(relPrefix, e.name);
    const git = decor.get(relPath);
    const row: DirRow = {
      name: e.name,
      relPath,
      isDirectory: isDir,
      icon: codiconForFileName(e.name, isDir),
    };
    if (git) {
      row.git = git;
    }
    rows.push(row);
  }
  rows.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return rows.slice(0, MAX_DIR_ENTRIES);
}

async function childrenForParentRel(parentRel: string): Promise<DirRow[] | { hint: string }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return { hint: "Open a folder workspace to browse files here." };
  }
  const decor = await getGitDecorationsForWorkspace();
  if (parentRel === "") {
    if (folders.length === 1) {
      return readDirectoryRows(folders[0]!.uri.fsPath, "", decor);
    }
    return folders.map((f) => ({
      name: f.name,
      relPath: f.name,
      isDirectory: true,
      icon: "codicon-root-folder",
    }));
  }
  const abs = resolveAbs(parentRel);
  if (!abs || !isUnderWorkspace(abs)) {
    return [];
  }
  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  return readDirectoryRows(abs, parentRel, decor);
}

/** Host class on `<html>` so CSS fallbacks match dark/light/HC when editor webviews omit some `--vscode-*` vars. */
function webviewThemeHtmlClass(): string {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return "vscode-light";
    case vscode.ColorThemeKind.HighContrast:
      return "vscode-high-contrast";
    case vscode.ColorThemeKind.HighContrastLight:
      return "vscode-high-contrast-light";
    case vscode.ColorThemeKind.Dark:
    default:
      return "vscode-dark";
  }
}

async function loadExplorerHtml(context: vscode.ExtensionContext, webview: vscode.Webview): Promise<string> {
  const htmlUri = vscode.Uri.joinPath(context.extensionUri, "media", "explorer-strip.html");
  const raw = await vscode.workspace.fs.readFile(htmlUri);
  const template = Buffer.from(raw).toString("utf8");
  const nonce = crypto.randomBytes(16).toString("base64");
  const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "codicons", "codicon.css"));
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return template
    .replaceAll("__NONCE__", nonce)
    .replaceAll("__CSP__", escapeHtmlAttribute(csp))
    .replaceAll("__CODICON_CSS__", escapeHtmlAttribute(codiconCssUri.toString()))
    .replaceAll("__HTML_THEME_CLASS__", webviewThemeHtmlClass());
}

function activeFileUri(): vscode.Uri | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri?.scheme === "file") {
    return uri;
  }
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
    const u = input.uri;
    if (u.scheme === "file") {
      return u;
    }
  }
  if (input instanceof vscode.TabInputTextDiff) {
    const u = input.modified;
    if (u.scheme === "file") {
      return u;
    }
  }
  if (input instanceof vscode.TabInputNotebook) {
    const u = input.uri;
    if (u.scheme === "file") {
      return u;
    }
  }
  if (input instanceof vscode.TabInputNotebookDiff) {
    const u = input.modified;
    if (u.scheme === "file") {
      return u;
    }
  }
  return undefined;
}

async function syncStripToActiveEditor(webview: vscode.Webview): Promise<void> {
  const uri = activeFileUri();
  if (!uri) {
    webview.postMessage({ type: "reveal", clear: true });
    return;
  }
  const rel = relPathFromFileUri(uri);
  if (!rel) {
    webview.postMessage({ type: "reveal", clear: true });
    return;
  }
  const abs = resolveAbs(rel);
  if (!abs || !isUnderWorkspace(abs)) {
    webview.postMessage({ type: "reveal", clear: true });
    return;
  }
  let isDir = false;
  try {
    const st = await fs.stat(abs);
    isDir = st.isDirectory();
  } catch {
    webview.postMessage({ type: "reveal", clear: true });
    return;
  }

  const expandPrefixes = [...new Set(isDir ? prefixesForDirectory(rel) : directoryPrefixesForRel(rel))];
  for (const p of expandPrefixes) {
    const rows = await childrenForParentRel(p);
    if ("hint" in rows) {
      return;
    }
    webview.postMessage({ type: "children", parentRel: p, entries: rows });
  }

  webview.postMessage({
    type: "reveal",
    relPath: isDir ? "" : rel,
    expandPrefixes,
    clear: false,
  });
}

/** Every path prefix along `relDir` (a directory), including `""` and `relDir`. */
function prefixesForDirectory(relDir: string): string[] {
  const parts = relDir.replace(/\\/g, "/").split("/").filter(Boolean);
  const out: string[] = [""];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push(acc);
  }
  return out;
}

const STRIP_CHROME_DELAY_MS = 220;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prefer opening documents in an editor column other than the file strip's group (works with locked strip group). */
function viewColumnForOpeningBesideStrip(panel: vscode.WebviewPanel): vscode.ViewColumn {
  const stripCol = panel.viewColumn;
  if (stripCol === undefined) {
    return vscode.ViewColumn.Beside;
  }
  const others: vscode.ViewColumn[] = [];
  for (const g of vscode.window.tabGroups.all) {
    const c = g.viewColumn;
    if (c !== undefined && c !== stripCol) {
      others.push(c);
    }
  }
  if (others.length === 0) {
    return vscode.ViewColumn.Beside;
  }
  if (stripCol === vscode.ViewColumn.One && others.includes(vscode.ViewColumn.Two)) {
    return vscode.ViewColumn.Two;
  }
  if (stripCol === vscode.ViewColumn.Two && others.includes(vscode.ViewColumn.One)) {
    return vscode.ViewColumn.One;
  }
  return others[0]!;
}

async function tryExecuteCommand(command: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(command);
    return true;
  } catch {
    return false;
  }
}

/** Pin the strip tab and lock its editor group so other files open in the other column. */
async function applyStripEditorChrome(panel: vscode.WebviewPanel): Promise<void> {
  panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
  await tryExecuteCommand("workbench.action.pinEditor");
  await tryExecuteCommand("workbench.action.lockEditorGroup");
}

export function openFilesStrip(context: vscode.ExtensionContext): void {
  if (stripPanel) {
    stripPanel.reveal(vscode.ViewColumn.Active, true);
    void syncStripToActiveEditor(stripPanel.webview);
    return;
  }

  const followDisposables: vscode.Disposable[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  void (async () => {
    await vscode.commands
      .executeCommand("vscode.setEditorLayout", {
        orientation: 1,
        groups: [{ size: 0.26 }, { size: 0.74 }],
      })
      .then(undefined, () => undefined);

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Side Dock · Files", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    });
    stripPanel = panel;

    const scheduleFollowActive = (): void => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const p = stripPanel;
        if (!p?.visible) {
          return;
        }
        void syncStripToActiveEditor(p.webview);
      }, FOLLOW_DEBOUNCE_MS);
    };

    followDisposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => scheduleFollowActive()),
      vscode.window.tabGroups.onDidChangeTabs(() => scheduleFollowActive()),
      vscode.workspace.onDidSaveTextDocument(() => {
        invalidateGitDecorationCache();
        scheduleFollowActive();
      }),
      vscode.workspace.onDidCreateFiles(() => {
        invalidateGitDecorationCache();
        scheduleFollowActive();
      }),
      vscode.workspace.onDidDeleteFiles(() => {
        invalidateGitDecorationCache();
        scheduleFollowActive();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        stripPanel?.webview.postMessage({ type: "theme", bodyClass: webviewThemeHtmlClass() });
      }),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          scheduleFollowActive();
        }
      }),
    );

    panel.webview.onDidReceiveMessage(async (msg: { type?: string; relPath?: string }) => {
      if (msg?.type === "ready") {
        const rows = await childrenForParentRel("");
        if ("hint" in rows) {
          stripPanel?.webview.postMessage({ type: "hint", message: rows.hint });
        } else {
          stripPanel?.webview.postMessage({ type: "children", parentRel: "", entries: rows });
          queueMicrotask(() => {
            const w = stripPanel?.webview;
            if (w) {
              void syncStripToActiveEditor(w);
            }
          });
        }
        return;
      }
      if (msg?.type === "expand" && typeof msg.relPath === "string") {
        const rows = await childrenForParentRel(msg.relPath);
        const entries = "hint" in rows ? [] : rows;
        stripPanel?.webview.postMessage({ type: "children", parentRel: msg.relPath, entries });
        return;
      }
      if (msg?.type === "open" && typeof msg.relPath === "string") {
        const abs = resolveAbs(msg.relPath);
        if (!abs || !isUnderWorkspace(abs)) {
          return;
        }
        try {
          const st = await fs.stat(abs);
          if (st.isDirectory()) {
            return;
          }
        } catch {
          return;
        }
        const uri = vscode.Uri.file(abs);
        const p = stripPanel;
        const viewColumn = p ? viewColumnForOpeningBesideStrip(p) : vscode.ViewColumn.Beside;
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, viewColumn });
        } catch {
          await vscode.commands.executeCommand("vscode.open", uri);
        }
      }
    });

    panel.onDidDispose(() => {
      clearTimeout(debounceTimer);
      for (const d of followDisposables) {
        d.dispose();
      }
      followDisposables.length = 0;
      stripPanel = undefined;
    });

    const html = await loadExplorerHtml(context, panel.webview);
    panel.webview.html = html;

    await sleep(STRIP_CHROME_DELAY_MS);
    if (stripPanel === panel) {
      await applyStripEditorChrome(panel);
    }
  })();
}
