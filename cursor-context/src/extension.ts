import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { buildCatalog } from "./catalog";
import { applyTitleRename, canRenameTitle } from "./rename";
import type { CatalogItem, CatalogKind, CatalogPayload } from "./types";
import { chatAtReference, chatPathReference } from "./references";

const VIEW_ID = "cursor-context.panel";

function debounce<T extends unknown[]>(fn: (...args: T) => void | Promise<void>, ms: number): (...args: T) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    if (t) {
      clearTimeout(t);
    }
    t = setTimeout(() => {
      t = undefined;
      void fn(...args);
    }, ms);
  };
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

class CursorContextViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") {
        await this.pushCatalog();
        return;
      }
      if (msg?.type === "open" && typeof msg.fsPath === "string") {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.fsPath as string));
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      if (msg?.type === "copyPath" && typeof msg.fsPath === "string") {
        const ref = typeof msg.pathRef === "string" ? msg.pathRef : msg.fsPath;
        await vscode.env.clipboard.writeText(ref);
        void vscode.window.setStatusBarMessage("Copied path", 2000);
        return;
      }
      if (msg?.type === "copyAt" && typeof msg.atRef === "string") {
        await vscode.env.clipboard.writeText(msg.atRef as string);
        void vscode.window.setStatusBarMessage("Copied @ reference", 2000);
        return;
      }
      if (msg?.type === "renameTitle") {
        const fsPath = typeof msg.fsPath === "string" ? msg.fsPath : "";
        const kindRaw = typeof msg.kind === "string" ? msg.kind : "";
        const kind = kindRaw as CatalogKind;
        const label = typeof msg.label === "string" ? msg.label : "";
        const currentTitle = typeof msg.currentTitle === "string" ? msg.currentTitle : "";
        const newTitle = typeof msg.newTitle === "string" ? msg.newTitle : "";
        const probe: Pick<CatalogItem, "kind" | "label" | "fsPath" | "detail"> = {
          kind,
          label,
          fsPath,
          detail: typeof msg.detail === "string" ? msg.detail : "",
        };
        if (!fsPath || !kindRaw || !canRenameTitle(probe)) {
          void vscode.window.showErrorMessage("This entry cannot be renamed from the panel.");
          return;
        }
        try {
          await applyTitleRename({ kind, fsPath, label }, currentTitle, newTitle);
          void vscode.window.setStatusBarMessage("Renamed", 2000);
        } catch (e) {
          void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
        }
        await this.pushCatalog();
        return;
      }
    });

    webviewView.webview.html = buildWebviewHtml(webviewView.webview, this.context.extensionUri);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.pushCatalog();
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  async refresh(): Promise<void> {
    await this.pushCatalog();
  }

  private async pushCatalog(): Promise<void> {
    if (!this.view) {
      return;
    }
    let payload: CatalogPayload;
    try {
      payload = await buildCatalog();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      payload = {
        type: "catalog",
        items: [],
        error: msg,
        homeCursor: path.join(process.env.HOME ?? "", ".cursor"),
      };
    }
    const enriched = payload.items.map((it) => ({
      ...it,
      pathRef: chatPathReference(it),
      atRef: chatAtReference(it),
      renameable: canRenameTitle(it),
    }));
    this.view.webview.postMessage({
      ...payload,
      items: enriched,
    });
  }
}

function registerWatchers(context: vscode.ExtensionContext, onFsChange: () => void): void {
  const patterns = [
    "**/.cursor/rules/**",
    "**/.cursor/commands/**",
    "**/.cursor/agents/**",
    "**/.cursor/skills/**",
    "**/.cursor/hooks/**",
    "**/.cursor/hooks.json",
    "**/.cursor/mcp.json",
    "**/AGENTS.md",
    "**/.cursorrules",
  ];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const pat of patterns) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pat));
      w.onDidChange(onFsChange);
      w.onDidCreate(onFsChange);
      w.onDidDelete(onFsChange);
      context.subscriptions.push(w);
    }
  }

  const home = path.join(process.env.HOME ?? "", ".cursor");
  if (fs.existsSync(home)) {
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(home), "**/*"));
      w.onDidChange(onFsChange);
      w.onDidCreate(onFsChange);
      w.onDidDelete(onFsChange);
      context.subscriptions.push(w);
    } catch {
      /* ignore */
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CursorContextViewProvider(context);
  const scheduleRefresh = debounce(() => {
    void provider.refresh();
  }, 300);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand("cursorContext.refresh", () => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cursor-context.skillGlobs")) {
        scheduleRefresh();
      }
    }),
  );

  registerWatchers(context, scheduleRefresh);
}
