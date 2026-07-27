import * as path from "path";
import * as vscode from "vscode";
import { parsePromptDirectives } from "./directives";
import { PromptSession } from "./promptStore";
import { buildStructure } from "./structureModel";
import type { HostToWebview, WebviewToHost } from "./types";
import { buildWebviewHtml } from "./webviewHtml";

export const VIEW_TYPE = "workflowStudio.editor";

export class WorkflowEditorProvider implements vscode.CustomTextEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new WorkflowEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
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
    );

    let currentRelativePath: string | undefined;
    let selectedNodeId: string | null = null;
    let disposed = false;
    let webviewReady = false;

    const workspaceRoots = () =>
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

    const pushInit = () => {
      const source = document.getText();
      const parsed = parsePromptDirectives(source);
      const structure = buildStructure(document.uri.fsPath, parsed.bindings, source);
      post({
        type: "init",
        fileName: path.basename(document.uri.fsPath),
        mermaidSource: source,
        bindings: parsed.bindings,
        structure,
        diagnostics: parsed.errors,
        selectedNodeId,
      });
    };

    const selectNode = async (nodeId: string) => {
      selectedNodeId = nodeId;
      const parsed = parsePromptDirectives(document.getText());
      const binding = parsed.bindings.find((b) => b.nodeId === nodeId);
      if (!binding) {
        currentRelativePath = undefined;
        await session.clearEditor();
        post({
          type: "promptError",
          nodeId,
          message: `Missing prompt binding for \`${nodeId}\`. Add \`%% @prompt ${nodeId} -> relative/path.md\`.`,
          recovery: "Add the directive near the top of the .mmd, save the graph file, then select the node again.",
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

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (webviewReady) {
        pushInit();
      }
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("workflowStudio.autosaveDelay", document.uri)) {
        session.setDelay(documentDelay(document));
      }
    });

    // Register before assigning html so the first "ready" is never missed.
    webviewPanel.webview.onDidReceiveMessage(async (raw: WebviewToHost) => {
      if (disposed || !raw || typeof raw !== "object" || !("type" in raw)) {
        return;
      }
      switch (raw.type) {
        case "ready":
          webviewReady = true;
          pushInit();
          return;
        case "selectNode":
          await selectNode(raw.nodeId);
          return;
        case "promptEdit":
          session.noteEdit(raw.content);
          return;
        case "conflictResolve": {
          const content = await session.resolveConflict(raw.choice);
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
        default: {
          const _exhaustive: never = raw;
          void _exhaustive;
          return;
        }
      }
    });

    const cacheKey = `v=${this.context.extension.packageJSON.version || "0"}`;
    webviewPanel.webview.html = buildWebviewHtml(
      webviewPanel.webview,
      this.context.extensionUri,
      cacheKey,
    );

    void vscode.window.setStatusBarMessage(
      `Workflow Studio: ${path.basename(document.uri.fsPath)}`,
      4000,
    );

    // Backup init in case ready was lost (should be rare after listener-first order).
    setTimeout(() => {
      if (!disposed && !webviewReady) {
        webviewReady = true;
        pushInit();
      }
    }, 250);

    webviewPanel.onDidDispose(() => {
      disposed = true;
      changeSub.dispose();
      configSub.dispose();
      void session.dispose();
    });
  }
}

function documentDelay(document: vscode.TextDocument): number {
  const cfg = vscode.workspace.getConfiguration("workflowStudio", document.uri);
  const value = cfg.get<number>("autosaveDelay", 400);
  return Number.isFinite(value) ? Math.min(5000, Math.max(100, value)) : 400;
}
