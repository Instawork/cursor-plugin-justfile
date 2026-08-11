import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { planAutomaticBindings } from "./autoBind";
import { defaultPromptPath, insertPromptDirective, insertPromptDirectives, starterWorkflow } from "./bindDirective";
import { findBindingForNode, parsePromptDirectives } from "./directives";
import { formatError, logError, logInfo, logWarn, showLog } from "./log";
import { parseWebviewToHost } from "./messages";
import { PromptSession } from "./promptStore";
import { resolvePromptTarget } from "./pathSafety";
import { nextUnbound } from "./railModel";
import { buildStructure } from "./structureModel";
import type { HostCommandName, HostToWebview, WebviewToHost } from "./types";
import { buildFatalHtml, buildWebviewHtml } from "./webviewHtml";

export const VIEW_TYPE = "workflowStudio.editor";

type ActivePanel = {
  document: vscode.TextDocument;
  webviewPanel: vscode.WebviewPanel;
  post: (msg: HostToWebview) => void;
  selectNode: (nodeId: string) => Promise<void>;
  getSelectedNodeId: () => string | null;
  bindPrompt: (nodeId: string) => Promise<void>;
  bindPromptsNow: () => Promise<void>;
  focusCommand: (command: HostCommandName) => void;
};

let activePanel: ActivePanel | undefined;
let providerInstance: WorkflowEditorProvider | undefined;

export function getActiveWorkflowPanel(): ActivePanel | undefined {
  return activePanel;
}

/** Plain WebviewPanel when Cursor's CustomTextEditor setInput asserts. */
export async function openStudioWebviewFallback(
  document: vscode.TextDocument,
): Promise<void> {
  if (!providerInstance) {
    throw new Error("Workflow Studio is not activated yet.");
  }
  const existing = getActiveWorkflowPanel();
  if (existing && existing.document.uri.toString() === document.uri.toString()) {
    existing.webviewPanel.reveal(undefined, false);
    return;
  }

  logInfo(`openStudioWebviewFallback ${document.uri.fsPath}`);
  const panel = vscode.window.createWebviewPanel(
    `${VIEW_TYPE}.fallback`,
    `Workflow Studio · ${path.basename(document.uri.fsPath)}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  await providerInstance.resolveCustomTextEditor(
    document,
    panel,
    new vscode.CancellationTokenSource().token,
  );
}

export class WorkflowEditorProvider implements vscode.CustomTextEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    providerInstance = new WorkflowEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, providerInstance, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const version = String(this.context.extension.packageJSON.version || "0");
    const fileName = path.basename(document.uri.fsPath);
    logInfo(`open ${document.uri.fsPath} (v${version})`);

    try {
      await this.resolveCustomTextEditorInner(document, webviewPanel, version, fileName);
    } catch (err) {
      const detail = formatError(err);
      logError(`resolveCustomTextEditor failed for ${document.uri.fsPath}`, err);
      webviewPanel.webview.options = { enableScripts: false };
      webviewPanel.webview.html = buildFatalHtml({
        title: "Workflow Studio failed to open",
        message: err instanceof Error ? err.message : "Unknown error while opening the editor.",
        detail,
        version,
        fileName,
      });
      void vscode.window
        .showErrorMessage(
          `Workflow Studio failed to open ${fileName}. See the Workflow Studio log.`,
          "Show Log",
        )
        .then((choice) => {
          if (choice === "Show Log") {
            showLog();
          }
        });
    }
  }

  private async resolveCustomTextEditorInner(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    version: string,
    fileName: string,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };

    const post = (msg: HostToWebview) => {
      void webviewPanel.webview.postMessage(msg);
    };

    const session = new PromptSession(
      (status) => post({ type: "saveStatus", status }),
      (payload) => post({ type: "conflict", ...payload }),
      (content) => {
        const nodeId = session.getNodeId();
        if (!nodeId) {
          return;
        }
        post({
          type: "promptLoaded",
          nodeId,
          relativePath: currentRelativePath ?? "",
          content,
          saveStatus: "saved",
        });
      },
      documentDelay(document),
      (targetPath) =>
        vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(targetPath)),
            path.basename(targetPath),
          ),
        ),
    );

    let currentRelativePath: string | undefined;
    let selectedNodeId: string | null = null;
    let disposed = false;
    let webviewReady = false;
    let writingDirective = false;
    let autoBindAttempted = false;
    let autoBindDiagnostics: string[] = [];

    const workspaceRoots = () =>
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

    const pushGraphStatus = () => {
      post({ type: "graphStatus", dirty: document.isDirty });
    };

    const listSiblingPromptPaths = async (): Promise<string[]> => {
      const stepsDir = path.join(path.dirname(document.uri.fsPath), "steps");
      try {
        const entries = await fs.readdir(stepsDir, { withFileTypes: true });
        const found = entries
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
          .map((entry) => path.posix.join("steps", entry.name))
          .sort((a, b) => a.localeCompare(b));
        logInfo(`auto-bind: ${found.length} prompt file(s) in ${stepsDir}`);
        return found;
      } catch {
        logInfo(`auto-bind: no steps directory at ${stepsDir}`);
        return [];
      }
    };

    const pushInit = () => {
      try {
        const source = document.getText();
        const parsed = parsePromptDirectives(source);
        const structure = buildStructure(document.uri.fsPath, parsed.bindings, source);
        post({
          type: "init",
          fileName: path.basename(document.uri.fsPath),
          mermaidSource: source,
          bindings: parsed.bindings,
          structure,
          diagnostics: [...parsed.errors, ...autoBindDiagnostics],
          selectedNodeId,
        });
        pushGraphStatus();
      } catch (err) {
        logError(`pushInit failed for ${document.uri.fsPath}`, err);
        post({
          type: "promptError",
          nodeId: null,
          message: err instanceof Error ? err.message : "Failed to parse workflow.",
          recovery: "Open the Workflow Studio log, then fix the .mmd or Reload Window.",
        });
      }
    };

    const selectNode = async (nodeId: string) => {
      selectedNodeId = nodeId;
      const parsed = parsePromptDirectives(document.getText());
      const binding = findBindingForNode(parsed.bindings, nodeId);
      if (!binding) {
        currentRelativePath = undefined;
        await session.clearEditor();
        post({
          type: "promptError",
          nodeId,
          message: `No prompt bound for \`${nodeId}\`.`,
          recovery: "Use Bind prompt to create or link a markdown file.",
        });
        return;
      }
      currentRelativePath = binding.relativePath;
      const result = await session.load(
        document.uri.fsPath,
        nodeId,
        binding.relativePath,
        workspaceRoots(),
      );
      if (!result.ok) {
        post({
          type: "promptError",
          nodeId,
          message: result.message,
          recovery: result.recovery,
        });
        return;
      }
      post({
        type: "promptLoaded",
        nodeId,
        relativePath: result.relativePath,
        content: result.content,
        saveStatus: session.getStatus(),
      });
    };

    const applySourceReplace = async (nextText: string): Promise<boolean> => {
      const edit = new vscode.WorkspaceEdit();
      const full = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      edit.replace(document.uri, full, nextText);
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) {
        await document.save();
      }
      return ok;
    };

    const withDirectiveWrite = async (fn: () => Promise<void>): Promise<void> => {
      writingDirective = true;
      try {
        await fn();
      } finally {
        writingDirective = false;
      }
    };

    const runAutoBind = async (force: boolean): Promise<string> => {
      const cfg = vscode.workspace.getConfiguration("workflowStudio", document.uri);
      if (!force && !cfg.get<boolean>("autoBindPrompts", true)) {
        logInfo("auto-bind: disabled by workflowStudio.autoBindPrompts");
        return "Automatic prompt binding is disabled (workflowStudio.autoBindPrompts).";
      }

      const promptPaths = await listSiblingPromptPaths();
      const plan = planAutomaticBindings(document.getText(), promptPaths);
      autoBindDiagnostics = plan.diagnostics;

      if (plan.status === "no-prompts") {
        const message = `No numbered prompt files found next to ${fileName}. Create steps/01-*.md to enable automatic binding.`;
        logInfo(`auto-bind: ${message}`);
        return message;
      }
      if (plan.status === "existing") {
        const count = parsePromptDirectives(document.getText()).bindings.length;
        const message = `${fileName} already has ${count} %% @prompt binding(s); leaving them unchanged.`;
        logInfo(`auto-bind: ${message}`);
        return message;
      }
      if (plan.status === "incomplete") {
        for (const diagnostic of plan.diagnostics) {
          logWarn(`auto-bind: ${diagnostic}`);
        }
        return `Automatic binding skipped — ${plan.diagnostics.length} unresolved mapping(s). See Workflow Studio: Show Log.`;
      }

      const outcome = insertPromptDirectives(document.getText(), plan.bindings);
      if (!outcome.ok) {
        logWarn(`auto-bind: insert failed: ${outcome.reason}`);
        autoBindDiagnostics = [`Auto-bind insert failed: ${outcome.reason}`];
        return `Automatic binding failed: ${outcome.reason}`;
      }
      let ok = false;
      await withDirectiveWrite(async () => {
        ok = await applySourceReplace(outcome.text);
      });
      if (!ok) {
        logWarn("auto-bind: could not update the workflow file");
        autoBindDiagnostics = ["Auto-bind could not update the workflow file."];
        return "Automatic binding could not write to the workflow file.";
      }
      for (const binding of plan.bindings) {
        logInfo(`auto-bind: bound ${binding.nodeId} -> ${binding.relativePath}`);
      }
      autoBindDiagnostics = [];
      return `Bound ${plan.bindings.length} prompt file(s) in ${fileName}.`;
    };

    const maybeAutoBindPrompts = async (): Promise<void> => {
      if (autoBindAttempted) {
        return;
      }
      autoBindAttempted = true;
      try {
        await runAutoBind(false);
      } catch (err) {
        logError("auto-bind failed", err);
      }
    };

    const bindPromptsNow = async (): Promise<void> => {
      const message = await runAutoBind(true);
      pushInit();
      void vscode.window.showInformationMessage(`Workflow Studio: ${message}`, "Show Log").then(
        (choice) => {
          if (choice === "Show Log") {
            showLog();
          }
        },
      );
    };

    const bindPrompt = async (nodeId: string, relativePath?: string) => {
      const rel = relativePath ?? defaultPromptPath(nodeId);
      const roots = workspaceRoots();
      const resolved = await resolvePromptTarget(document.uri.fsPath, rel, roots, {
        allowMissingDirs: true,
      });
      if (!resolved.safe || !resolved.targetPath) {
        post({
          type: "promptError",
          nodeId,
          message: resolved.reason ?? "Cannot bind prompt path.",
          recovery: "Choose a path inside the workspace that is not a secret file.",
        });
        return;
      }

      const outcome = insertPromptDirective(document.getText(), nodeId, rel);
      if (!outcome.ok) {
        post({
          type: "promptError",
          nodeId,
          message: outcome.reason,
          recovery: "Pick a different node or remove the existing binding.",
        });
        return;
      }

      let ok = false;
      await withDirectiveWrite(async () => {
        await fs.mkdir(path.dirname(resolved.targetPath!), { recursive: true });
        try {
          await fs.access(resolved.targetPath!);
        } catch {
          await fs.writeFile(
            resolved.targetPath!,
            `# ${nodeId}\n\nDescribe this step.\n`,
            "utf8",
          );
        }
        ok = await applySourceReplace(outcome.text);
      });
      if (!ok) {
        post({
          type: "promptError",
          nodeId,
          message: "Could not update the workflow file.",
          recovery: "Ensure the .mmd is writable, then try again.",
        });
        return;
      }

      selectedNodeId = nodeId;
      pushInit();
      await selectNode(nodeId);
    };

    const linkPrompt = async (nodeId: string) => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Link prompt",
        filters: { Markdown: ["md"] },
        defaultUri: vscode.Uri.file(path.dirname(document.uri.fsPath)),
      });
      const file = picked?.[0];
      if (!file) {
        return;
      }
      const diagramDir = path.dirname(document.uri.fsPath);
      let relative = path.relative(diagramDir, file.fsPath).replaceAll("\\", "/");
      if (!relative || relative.startsWith("..")) {
        post({
          type: "promptError",
          nodeId,
          message: "Linked file must stay under the workflow directory or workspace.",
          recovery: "Pick a markdown file near the .mmd.",
        });
        return;
      }
      await bindPrompt(nodeId, relative);
    };

    const insertStarter = async () => {
      if (document.getText().trim().length > 0) {
        const choice = await vscode.window.showWarningMessage(
          "Replace the current workflow with a starter template?",
          "Replace",
          "Cancel",
        );
        if (choice !== "Replace") {
          return;
        }
      }
      const text = starterWorkflow();
      let ok = false;
      await withDirectiveWrite(async () => {
        const diagramDir = path.dirname(document.uri.fsPath);
        for (const name of ["Triage", "Confirm", "Done"]) {
          const target = path.join(diagramDir, "steps", `${name}.md`);
          await fs.mkdir(path.dirname(target), { recursive: true });
          try {
            await fs.access(target);
          } catch {
            await fs.writeFile(target, `# ${name}\n\nDescribe this step.\n`, "utf8");
          }
        }
        ok = await applySourceReplace(text);
      });
      if (!ok) {
        return;
      }
      selectedNodeId = "Triage";
      pushInit();
      await selectNode("Triage");
    };

    const openPromptUri = async (command: string) => {
      const abs = session.getAbsolutePath();
      if (!abs) {
        return;
      }
      const uri = vscode.Uri.file(abs);
      if (command === "reveal") {
        await vscode.commands.executeCommand("revealInExplorer", uri);
        return;
      }
      if (command === "preview") {
        await vscode.commands.executeCommand("markdown.showPreview", uri);
        return;
      }
      await vscode.window.showTextDocument(uri, { preview: false });
    };

    const panelApi: ActivePanel = {
      document,
      webviewPanel,
      post,
      selectNode,
      getSelectedNodeId: () => selectedNodeId,
      bindPrompt: (nodeId) => bindPrompt(nodeId),
      bindPromptsNow: () => bindPromptsNow(),
      focusCommand: (command) => post({ type: "command", command }),
    };

    const setActive = () => {
      activePanel = panelApi;
    };
    setActive();

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      pushGraphStatus();
      if (writingDirective) {
        return;
      }
      if (webviewReady) {
        pushInit();
      }
    });

    const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.toString() !== document.uri.toString()) {
        return;
      }
      pushGraphStatus();
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("workflowStudio.autosaveDelay", document.uri)) {
        session.setDelay(documentDelay(document));
      }
    });

    const viewSub = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        setActive();
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      if (disposed) {
        return;
      }
      const msg = parseWebviewToHost(raw);
      if (!msg) {
        logWarn(`ignored webview message: ${safeJson(raw)}`);
        return;
      }
      try {
        switch (msg.type) {
          case "ready":
            webviewReady = true;
            await maybeAutoBindPrompts();
            pushInit();
            return;
          case "selectNode":
            await selectNode(msg.nodeId);
            return;
          case "promptEdit":
            session.noteEdit(msg.content);
            return;
          case "conflictResolve": {
            const content = await session.resolveConflict(msg.choice);
            if (content !== undefined && selectedNodeId && currentRelativePath) {
              post({
                type: "promptLoaded",
                nodeId: selectedNodeId,
                relativePath: currentRelativePath,
                content,
                saveStatus: session.getStatus(),
              });
            }
            return;
          }
          case "forceFlush":
            await session.flush();
            return;
          case "bindPrompt":
            await bindPrompt(msg.nodeId);
            return;
          case "linkPrompt":
            await linkPrompt(msg.nodeId);
            return;
          case "insertStarter":
            await insertStarter();
            return;
          case "openMmdAsText":
            await vscode.window.showTextDocument(document, {
              preview: false,
              viewColumn: vscode.ViewColumn.Beside,
            });
            return;
          case "openPromptInEditor":
            await openPromptUri("open");
            return;
          case "revealPrompt":
            await openPromptUri("reveal");
            return;
          case "previewPrompt":
            await openPromptUri("preview");
            return;
          case "retryGraph":
            pushInit();
            return;
          case "webviewLog":
            if (msg.level === "error") {
              logError(`webview: ${msg.message}`);
            } else if (msg.level === "warn") {
              logWarn(`webview: ${msg.message}`);
            } else {
              logInfo(`webview: ${msg.message}`);
            }
            return;
          default: {
            const _exhaustive: never = msg;
            void _exhaustive;
            return;
          }
        }
      } catch (err) {
        logError(`webview message handler failed (${msg.type})`, err);
        post({
          type: "promptError",
          nodeId: selectedNodeId,
          message: err instanceof Error ? err.message : "Action failed.",
          recovery: "See Workflow Studio: Show Log, then retry.",
        });
      }
    });

    const cacheKey = `v=${version}`;
    const beautifulMermaidUri = webviewPanel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "beautiful-mermaid.js"))
      .with({ query: cacheKey })
      .toString();
    webviewPanel.webview.html = buildWebviewHtml(
      webviewPanel.webview,
      this.context.extensionUri,
      beautifulMermaidUri,
    );

    void vscode.window.setStatusBarMessage(`Workflow Studio: ${fileName}`, 4000);

    setTimeout(() => {
      if (!disposed && !webviewReady) {
        webviewReady = true;
        void maybeAutoBindPrompts().then(() => {
          if (!disposed) {
            pushInit();
          }
        });
      }
    }, 250);

    webviewPanel.onDidDispose(() => {
      disposed = true;
      if (activePanel === panelApi) {
        activePanel = undefined;
      }
      changeSub.dispose();
      saveSub.dispose();
      configSub.dispose();
      viewSub.dispose();
      void session.dispose();
    });
  }
}

export async function runStudioCommand(command: HostCommandName): Promise<void> {
  const panel = getActiveWorkflowPanel();
  if (!panel) {
    void vscode.window.showInformationMessage("Open a .mmd in Workflow Studio first.");
    return;
  }
  panel.webviewPanel.reveal(undefined, true);
  if (command === "bindSelectedNode") {
    const nodeId = panel.getSelectedNodeId();
    if (!nodeId) {
      void vscode.window.showInformationMessage("Select an unbound node first.");
      return;
    }
    await panel.bindPrompt(nodeId);
    return;
  }
  if (command === "nextUnbound") {
    const source = panel.document.getText();
    const parsed = parsePromptDirectives(source);
    const structure = buildStructure(panel.document.uri.fsPath, parsed.bindings, source);
    const next = nextUnbound(structure, panel.getSelectedNodeId());
    if (!next) {
      void vscode.window.showInformationMessage("No unbound nodes.");
      return;
    }
    await panel.selectNode(next);
    panel.focusCommand("focusRail");
    return;
  }
  panel.focusCommand(command);
}

function documentDelay(document: vscode.TextDocument): number {
  const cfg = vscode.workspace.getConfiguration("workflowStudio", document.uri);
  const value = cfg.get<number>("autosaveDelay", 400);
  return Number.isFinite(value) ? Math.min(5000, Math.max(100, value)) : 400;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
