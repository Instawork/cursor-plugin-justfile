import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  insertWorkFromQuickAdd,
  removeTaskRow,
  reorderTasks,
  setTodoDone,
  setTodoDonePersistent,
  updateTaskFields,
} from "./activeTasks";
import { activeTasksDbPath, seedActiveWorkIfEmpty } from "./activeTasksStore";
import type { TaskFieldUpdate } from "./taskModel";
import { coerceOpenGitHubPr } from "./githubOpenPrs";
import {
  invalidateTaskDiscoveryCache,
  loadTaskDiscovery,
  reconcileAddPr,
  reconcileAttachPr,
  reconcileDismissItem,
  reconcileMergeWorkRows,
} from "./discovery";
import {
  activeTasksStatusBarText,
  loadActiveTasksPayload,
  type ActiveTasksPayload,
} from "./payload";
import { enrichDiscoveryWithConsolidation } from "./workConsolidation";
import {
  discoveryWarnings,
  formatPanelError,
  type PanelNotice,
} from "./panelNotice";
import { detectWorkspaceMatch } from "./workspaceContext";

const VIEW_ID = "activeTasks.panel";
const HTML_FILE = "active-tasks-panel.html";
const POPOUT_TITLE = "Active tasks";

function tasksTooltip(payload: ActiveTasksPayload): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  const todos = payload.activeTasks.todos || [];
  const open = todos.filter((t) => !t.done).length;
  const done = todos.length - open;
  md.appendMarkdown("### Active Tasks\n\n");
  md.appendMarkdown("**Overview**\n");
  if (todos.length) {
    md.appendMarkdown(
      `- Open: **${open}**\n- Done: **${done}**\n- Total: **${todos.length}**`
    );
  } else if (payload.loadError) {
    md.appendMarkdown(`- **Error:** ${payload.loadError}`);
  } else {
    md.appendMarkdown("- No active tasks loaded.");
  }
  const d = payload.discovery;
  if (d.missingPrs.length || d.staleTrackedPrs.length) {
    md.appendMarkdown(
      `\n- Reconcile: **${d.missingPrs.length}** untracked PRs, **${d.staleTrackedPrs.length}** stale`
    );
  }
  if (d.structuralMergeCandidates?.length) {
    md.appendMarkdown(
      `\n- Structural merges: **${d.structuralMergeCandidates.length}** duplicate links`
    );
  }
  const agent = d.agentConsolidation;
  if (agent?.overRecommended) {
    md.appendMarkdown(
      `\n- Agent consolidate: **${agent.openCount}** open rows (target 3–8)`
    );
  }
  md.appendMarkdown("\n\n---\n\n");
  md.appendMarkdown("**Actions**\n");
  md.appendMarkdown(
    "[Open panel](command:activeTasks.open) · [Pop out](command:activeTasks.popOut) · [Refresh](command:activeTasks.refresh)"
  );
  return md;
}

export class SidebarPanelProvider implements vscode.WebviewViewProvider {
  constructor(private readonly host: PanelHost) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.host.bindSidebar(webviewView);
  }
}

export class PanelHost {
  private sidebar: vscode.WebviewView | undefined;
  private popout: vscode.WebviewPanel | undefined;
  private wired = new WeakSet<vscode.Webview>();
  private htmlLoaded = new WeakSet<vscode.Webview>();
  private statusBar: vscode.StatusBarItem;
  private refreshGen = 0;
  private pushTimer: NodeJS.Timeout | undefined;
  private pendingPush: { forceDiscovery?: boolean; skipDiscovery?: boolean } = {};
  private lastPayload: ActiveTasksPayload | undefined;
  private panelNotice: PanelNotice | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      39
    );
    this.statusBar.name = "Active Tasks";
    this.statusBar.command = "activeTasks.open";
    this.statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.prominentBackground"
    );
    this.statusBar.tooltip =
      "Active tasks status. Click to open the activity panel.";
    this.statusBar.show();
  }

  dispose(): void {
    this.statusBar.dispose();
    this.popout?.dispose();
    this.popout = undefined;
  }

  bindSidebar(view: vscode.WebviewView): void {
    this.sidebar = view;
    this.wireWebview(view.webview);
    view.onDidDispose(() => {
      if (this.sidebar === view) {
        this.sidebar = undefined;
      }
    });
    this.pushUpdate();
  }

  popOut(): void {
    if (this.popout) {
      this.popout.reveal(vscode.ViewColumn.Beside, true);
      this.pushUpdate();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_ID + ".popout",
      POPOUT_TITLE,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg");
    this.popout = panel;
    this.wireWebview(panel.webview);
    panel.onDidDispose(() => {
      if (this.popout === panel) {
        this.popout = undefined;
      }
    });
    this.pushUpdate();
  }

  private workspaceContext() {
    return detectWorkspaceMatch(vscode.workspace.workspaceFolders);
  }

  async copyAgentConsolidationBrief(): Promise<void> {
    const payload = loadActiveTasksPayload(this.workspaceContext());
    const enriched = enrichDiscoveryWithConsolidation(
      payload.discovery,
      payload.activeTasks.todos
    );
    const brief =
      enriched.agentConsolidation?.brief ??
      "No open active work rows.";
    await vscode.env.clipboard.writeText(brief);
    void vscode.window.showInformationMessage(
      "Active work consolidation brief copied — paste into Agent chat."
    );
  }

  private finalizePayload(
    base: ActiveTasksPayload,
    workspace: ReturnType<PanelHost["workspaceContext"]>
  ): ActiveTasksPayload {
    const enriched = enrichDiscoveryWithConsolidation(
      base.discovery,
      base.activeTasks.todos
    );
    let notice: PanelNotice | null = base.notice ?? null;
    if (base.loadError) {
      notice = {
        level: "error",
        title: "Database unavailable",
        detail: base.loadError,
        action: "retry",
      };
    } else if (this.panelNotice) {
      notice = this.panelNotice;
    } else if (!notice) {
      notice = discoveryWarnings({ ...base, discovery: enriched });
    }
    return {
      ...base,
      discovery: enriched,
      notice,
    };
  }

  private applyPayload(payload: ActiveTasksPayload): void {
    this.post({ type: "update", payload });
    this.statusBar.text = activeTasksStatusBarText(payload);
    this.statusBar.tooltip = tasksTooltip(payload);
    if (payload.loadError || payload.notice?.level === "error") {
      this.statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
    } else {
      this.statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.prominentBackground"
      );
    }
    this.lastPayload = payload;
  }

  private setPanelError(
    title: string,
    err: unknown,
    action?: PanelNotice["action"]
  ): void {
    this.panelNotice = {
      level: "error",
      title,
      detail: formatPanelError(err),
      action: action ?? "retry",
    };
  }

  private clearPanelNotice(): void {
    this.panelNotice = null;
  }

  private runPanelAction(title: string, fn: () => void): void {
    try {
      fn();
      this.clearPanelNotice();
    } catch (err) {
      this.setPanelError(title, err);
      this.pushUpdate({ skipDiscovery: true });
    }
  }

  pushUpdate(options?: {
    forceDiscovery?: boolean;
    skipDiscovery?: boolean;
  }): void {
    if (options?.forceDiscovery) {
      this.pendingPush.forceDiscovery = true;
      this.pendingPush.skipDiscovery = false;
    } else if (options?.skipDiscovery) {
      this.pendingPush.skipDiscovery = true;
    }
    if (this.pushTimer) {
      return;
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      const opts = this.pendingPush;
      this.pendingPush = {};
      this.flushPushUpdate(opts);
    }, 120);
  }

  private flushPushUpdate(options?: {
    forceDiscovery?: boolean;
    skipDiscovery?: boolean;
  }): void {
    const workspace = this.workspaceContext();
    try {
      const payload = this.finalizePayload(
        loadActiveTasksPayload(workspace),
        workspace
      );
      this.applyPayload(payload);

      if (options?.skipDiscovery && !options?.forceDiscovery) {
        return;
      }

      const gen = ++this.refreshGen;
      void loadTaskDiscovery(
        this.context.secrets,
        payload.activeTasks.todos,
        workspace,
        { force: options?.forceDiscovery }
      )
        .then((discovery) => {
          if (gen !== this.refreshGen) {
            return;
          }
          const next = this.finalizePayload(
            {
              ...loadActiveTasksPayload(workspace),
              discovery,
            },
            workspace
          );
          this.applyPayload(next);
        })
        .catch((err) => {
          if (gen !== this.refreshGen) {
            return;
          }
          this.setPanelError("Discovery scan failed", err);
          const next = this.finalizePayload(
            loadActiveTasksPayload(workspace),
            workspace
          );
          this.applyPayload(next);
        });
    } catch (err) {
      this.setPanelError("Active Tasks failed to refresh", err);
      this.applyPayload(
        this.finalizePayload(loadActiveTasksPayload(workspace), workspace)
      );
    }
  }

  private deliverCachedPayload(webview: vscode.Webview): void {
    if (this.lastPayload) {
      void webview.postMessage({ type: "update", payload: this.lastPayload });
    }
  }

  private post(message: { type: string; payload: ActiveTasksPayload }): void {
    const targets: vscode.Webview[] = [];
    if (this.sidebar) {
      targets.push(this.sidebar.webview);
    }
    if (this.popout) {
      targets.push(this.popout.webview);
    }
    for (const webview of targets) {
      void webview.postMessage(message);
    }
  }

  private openWorktreePath(raw: string): void {
    if (!raw || raw.includes("\0")) {
      return;
    }
    const expanded = raw.startsWith("~")
      ? path.join(os.homedir(), raw.slice(1).replace(/^\//, ""))
      : path.resolve(raw);
    const normalized = path.normalize(expanded);
    if (!fs.existsSync(normalized)) {
      void vscode.window.showWarningMessage(`Worktree not found: ${normalized}`);
      return;
    }
    void vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(normalized),
      { forceNewWindow: false }
    );
  }

  private wireWebview(webview: vscode.Webview): void {
    if (!this.wired.has(webview)) {
      this.wired.add(webview);
      webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
        const type = msg.type;
        if (type === "openUrl" && typeof msg.url === "string") {
          const url = msg.url.trim();
          if (/^https?:\/\//i.test(url)) {
            void vscode.env.openExternal(vscode.Uri.parse(url));
          }
          return;
        }
        if (type === "openWorktree" && typeof msg.path === "string") {
          this.openWorktreePath(msg.path.trim());
          return;
        }
        if (type === "openDatabase") {
          const db = activeTasksDbPath();
          void vscode.window.showTextDocument(vscode.Uri.file(db), {
            preview: false,
          });
          return;
        }
        if (type === "refresh") {
          invalidateTaskDiscoveryCache();
          this.pushUpdate({ forceDiscovery: true });
          return;
        }
        if (type === "resyncDatabase") {
          this.runPanelAction("Sync from database failed", () => {
            invalidateTaskDiscoveryCache();
            seedActiveWorkIfEmpty();
            this.pushUpdate({ forceDiscovery: true });
          });
          return;
        }
        if (type === "dismissNotice") {
          this.clearPanelNotice();
          this.pushUpdate({ skipDiscovery: true });
          return;
        }
        if (type === "popOut") {
          this.popOut();
          return;
        }
        if (type === "toggleTodo" && typeof msg.id === "string") {
          setTodoDone(msg.id, Boolean(msg.done));
          this.pushUpdate({ skipDiscovery: true });
          return;
        }
        if (
          type === "setDoneMode" &&
          typeof msg.id === "string" &&
          typeof msg.mode === "string"
        ) {
          const mode = msg.mode;
          if (mode === "session" || mode === "remove" || mode === "archive") {
            setTodoDonePersistent(msg.id, mode);
            invalidateTaskDiscoveryCache();
            this.pushUpdate({ forceDiscovery: true });
          }
          return;
        }
        if (type === "reorderTodos" && Array.isArray(msg.order)) {
          const ids = msg.order.filter(
            (x): x is string => typeof x === "string"
          );
          if (ids.length) {
            reorderTasks(ids);
            this.pushUpdate({ skipDiscovery: true });
          }
          return;
        }
        if (
          type === "updateTodo" &&
          typeof msg.id === "string" &&
          msg.fields &&
          typeof msg.fields === "object"
        ) {
          this.runPanelAction("Save failed", () => {
            const ok = updateTaskFields(
              msg.id as string,
              msg.fields as TaskFieldUpdate
            );
            if (!ok) {
              throw new Error("Task row not found or invalid fields.");
            }
            invalidateTaskDiscoveryCache();
            this.pushUpdate({ forceDiscovery: true });
          });
          return;
        }
        if (type === "reconcileAddPr" && msg.pr && typeof msg.pr === "object") {
          const pr = coerceOpenGitHubPr(msg.pr);
          if (pr) {
            reconcileAddPr(pr);
            invalidateTaskDiscoveryCache();
            this.pushUpdate({ forceDiscovery: true });
          }
          return;
        }
        if (
          type === "reconcileAttachPr" &&
          typeof msg.workId === "string" &&
          msg.pr &&
          typeof msg.pr === "object"
        ) {
          const pr = coerceOpenGitHubPr(msg.pr);
          if (pr) {
            reconcileAttachPr(msg.workId.trim(), pr);
            invalidateTaskDiscoveryCache();
            this.pushUpdate({ forceDiscovery: true });
          }
          return;
        }
        if (
          type === "reconcileDismiss" &&
          typeof msg.kind === "string" &&
          typeof msg.refKey === "string"
        ) {
          const kind = msg.kind;
          if (kind !== "pr" && kind !== "cloud") {
            return;
          }
          const refKey = msg.refKey.trim();
          if (!refKey) {
            return;
          }
          reconcileDismissItem(kind, refKey);
          invalidateTaskDiscoveryCache();
          this.pushUpdate({ forceDiscovery: true });
          return;
        }
        if (type === "reconcileRemoveRow" && typeof msg.id === "string") {
          removeTaskRow(msg.id);
          invalidateTaskDiscoveryCache();
          this.pushUpdate({ forceDiscovery: true });
          return;
        }
        if (type === "copyAgentConsolidationBrief") {
          void this.copyAgentConsolidationBrief();
          return;
        }
        if (
          type === "mergeWorkRows" &&
          typeof msg.primaryId === "string" &&
          Array.isArray(msg.mergeIds)
        ) {
          const mergeIds = msg.mergeIds.filter(
            (x): x is string => typeof x === "string"
          );
          if (mergeIds.length) {
            reconcileMergeWorkRows(msg.primaryId.trim(), mergeIds);
            invalidateTaskDiscoveryCache();
            this.pushUpdate({ forceDiscovery: true });
          }
          return;
        }
        if (type === "quickAddWork" && typeof msg.title === "string") {
          const title = msg.title.trim();
          const status =
            typeof msg.status === "string" && msg.status.trim()
              ? msg.status.trim()
              : "in progress";
          if (!title) {
            return;
          }
          this.runPanelAction("Add task failed", () => {
            const ws = this.workspaceContext();
            const id = insertWorkFromQuickAdd(title, status, ws.repoKey ?? null);
            if (!id) {
              throw new Error("Could not insert task (empty title or status).");
            }
            invalidateTaskDiscoveryCache();
            this.pushUpdate({ forceDiscovery: true });
          });
          return;
        }
      });
    }
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    const htmlPath = vscode.Uri.joinPath(
      this.extensionUri,
      "media",
      HTML_FILE
    );
    if (!this.htmlLoaded.has(webview)) {
      this.htmlLoaded.add(webview);
      webview.html = fs.readFileSync(htmlPath.fsPath, "utf8");
    }
    this.deliverCachedPayload(webview);
  }
}
