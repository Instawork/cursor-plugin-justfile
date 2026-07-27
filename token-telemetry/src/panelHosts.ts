import * as fs from "fs";
import * as vscode from "vscode";
import {
  defaultPaths,
  fmtCents,
  fmtTokens,
  fmtUsdRounded,
  fmtUsdShort,
  loadUsagePayloadAsync,
  usageStatusBarText,
  type UsagePayload,
} from "./telemetry";
import { logTelemetryError } from "./dbLog";
import type { CloudSyncStatus } from "./cloudSyncTypes";

const VIEW_ID = "tokenTelemetry.usagePanel";
const HTML_FILE = "usage-panel.html";
const POPOUT_TITLE = "Cursor usage (last prompt)";

function usageTooltip(payload: UsagePayload): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  const day = payload.dayTotals || {
    cost_usd: 0,
    total_tokens: 0,
    output_tokens: 0,
    turn_count: 0,
  };
  const daily = payload.dailySnapshot;
  const dayCumCost = Number(daily?.cumulative_cost_usd || daily?.cost_usd || 0);
  const dayCumTok = Number(
    daily?.cumulative_total_tokens || daily?.total_tokens || 0
  );
  md.appendMarkdown("### Cursor Usage\n\n");
  md.appendMarkdown("**Today (UTC cumulative)**\n");
  md.appendMarkdown(
    `- Turn spend: **${fmtUsdShort(day.cost_usd)}**\n` +
      `- Day cumulative: **${fmtUsdRounded(dayCumCost)}** · **${fmtTokens(dayCumTok)} tok**\n` +
      `- Turns: **${Number(day.turn_count).toLocaleString()}** · Output: **${fmtTokens(
        day.output_tokens
      )}**`
  );
  if (payload.costMismatchCount > 0) {
    md.appendMarkdown(
      `\n\n_Pricing check: ${payload.costMismatchCount} turn(s) differ from hook rates by >0.05¢._`
    );
  }
  if (payload.cloudSync?.lastError) {
    md.appendMarkdown(
      `\n\n_Cloud sync: ${payload.cloudSync.lastError}_`
    );
  } else if (payload.cloudSync?.apiKeyConfigured && payload.cloudSync.lastSyncAt) {
    md.appendMarkdown(
      `\n\n_Cloud sync: ${payload.cloudSync.lastRunsIngested} run(s) on last sync._`
    );
  }
  md.appendMarkdown("\n\n---\n\n");
  md.appendMarkdown("**Actions**\n");
  md.appendMarkdown(
    "[Open panel](command:tokenTelemetry.openUsage) · [Pop out](command:tokenTelemetry.popOutUsage) · [Refresh](command:tokenTelemetry.refresh)"
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
  private statusBar: vscode.StatusBarItem;
  private loadGeneration = 0;
  private lastPayload: UsagePayload | null = null;
  private lastStatusBarText: string | undefined;
  private pushTimer: NodeJS.Timeout | undefined;
  private pendingShowSync = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly cloudSyncStatus: () => CloudSyncStatus | null = () => null
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      40
    );
    this.statusBar.name = "Token Telemetry Usage";
    this.statusBar.command = "tokenTelemetry.openUsage";
    this.statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.prominentBackground"
    );
    this.statusBar.tooltip =
      "Cursor usage status. Click to open the activity panel.";
    this.statusBar.show();
  }

  dispose(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
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
    this.pushUpdate({ showSync: true });
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

  pushUpdate(options?: { showSync?: boolean }): void {
    if (options?.showSync) {
      this.pendingShowSync = true;
    }
    if (this.pushTimer) {
      return;
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      const showSync = this.pendingShowSync;
      this.pendingShowSync = false;
      void this.pushUpdateAsync(showSync);
    }, 280);
  }

  private applyStatusBar(payload: UsagePayload): void {
    const text = usageStatusBarText(payload);
    if (text === this.lastStatusBarText) {
      return;
    }
    this.lastStatusBarText = text;
    this.statusBar.text = text;
    this.statusBar.tooltip = usageTooltip(payload);
  }

  private async pushUpdateAsync(showSync: boolean): Promise<void> {
    const gen = ++this.loadGeneration;
    if (showSync && !this.lastPayload) {
      this.statusBar.text = "$(sync~) Usage…";
    }
    const { csvPath, statePath } = defaultPaths();
    try {
      const payload = await loadUsagePayloadAsync(
        csvPath,
        statePath,
        this.cloudSyncStatus()
      );
      if (gen !== this.loadGeneration) {
        return;
      }
      this.lastPayload = payload;
      this.post({ type: "update", payload });
      this.applyStatusBar(payload);
    } catch (err) {
      if (gen !== this.loadGeneration) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logTelemetryError("Failed to load usage payload", msg);
      if (this.lastPayload) {
        this.applyStatusBar(this.lastPayload);
      } else {
        const text = "$(error) Usage";
        if (text !== this.lastStatusBarText) {
          this.lastStatusBarText = text;
          this.statusBar.text = text;
        }
      }
    }
  }

  private post(message: { type: string; payload: UsagePayload }): void {
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

  private wireWebview(webview: vscode.Webview): void {
    if (!this.wired.has(webview)) {
      this.wired.add(webview);
      webview.onDidReceiveMessage(
        (msg: { type?: string; url?: string }) => {
          if (msg.type === "openUrl" && typeof msg.url === "string") {
            const url = msg.url.trim();
            if (/^https?:\/\//i.test(url)) {
              void vscode.env.openExternal(vscode.Uri.parse(url));
            }
            return;
          }
          if (msg.type === "refresh") {
            this.pushUpdate({ showSync: true });
            return;
          }
          if (msg.type === "popOut") {
            this.popOut();
          }
        }
      );
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
    webview.html = fs.readFileSync(htmlPath.fsPath, "utf8");
  }
}
