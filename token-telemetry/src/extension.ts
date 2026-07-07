import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  markCloudSyncComplete,
  refreshCloudSyncStatus,
  syncCloudAgentUsage,
} from "./cloudSync";
import type { CloudSyncStatus } from "./cloudSyncTypes";
import {
  clearCloudApiKey,
  getCloudApiKey,
  setCloudApiKey,
} from "./cloudSecrets";
import {
  migrateSqliteIfNeeded,
  setDbQueryTimeoutMs,
} from "./dbQuery";
import {
  disposeTelemetryOutputChannel,
  getTelemetryOutputChannel,
  logTelemetryError,
  logTelemetryInfo,
} from "./dbLog";
import { setIngestTimeoutMs } from "./ingestCli";
import { hooksInstalled, installHooks } from "./installHooks";
import { PanelHost, SidebarPanelProvider } from "./panelHosts";
import { defaultPaths, initTelemetryDataSource } from "./telemetry";

let host: PanelHost | undefined;
let cloudSyncState: CloudSyncStatus | null = null;
let cloudSyncInFlight = false;

function applyTimeoutSettings(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("tokenTelemetry");
  const seconds = cfg.get<number>("dbQueryTimeoutSeconds", 120);
  const ms = Math.max(5, Math.min(seconds, 600)) * 1000;
  setDbQueryTimeoutMs(ms);
  setIngestTimeoutMs(ms);
}

function cloudConfig(): {
  enabled: boolean;
  intervalMinutes: number;
  lookbackDays: number;
  maxIngestPerSync: number;
} {
  const cfg = vscode.workspace.getConfiguration("tokenTelemetry.cloudSync");
  return {
    enabled: cfg.get<boolean>("enabled", true),
    intervalMinutes: Math.max(1, cfg.get<number>("intervalMinutes", 5)),
    lookbackDays: Math.max(1, cfg.get<number>("lookbackDays", 14)),
    maxIngestPerSync: Math.max(1, cfg.get<number>("maxIngestPerSync", 40)),
  };
}

async function refreshCloudSyncMeta(
  context: vscode.ExtensionContext,
  lastError: string | null,
  lastRunsIngested?: number
): Promise<void> {
  cloudSyncState = await refreshCloudSyncStatus(
    context,
    context.secrets,
    lastError,
    lastRunsIngested
  );
}

async function runCloudSync(context: vscode.ExtensionContext): Promise<void> {
  const { enabled, lookbackDays, maxIngestPerSync } = cloudConfig();
  if (!enabled || cloudSyncInFlight) {
    return;
  }
  const apiKey = await getCloudApiKey(context.secrets);
  if (!apiKey) {
    await refreshCloudSyncMeta(context, null);
    host?.pushUpdate();
    return;
  }
  cloudSyncInFlight = true;
  try {
    const { ingested } = await syncCloudAgentUsage(
      context.extensionPath,
      apiKey,
      { lookbackDays, maxIngestPerSync }
    );
    await markCloudSyncComplete(context, ingested);
    await refreshCloudSyncMeta(context, null, ingested);
    if (ingested > 0) {
      logTelemetryInfo(`Cloud sync ingested ${ingested} run(s)`);
      host?.pushUpdate();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logTelemetryError("Cloud sync failed", msg);
    await refreshCloudSyncMeta(context, msg);
    host?.pushUpdate();
  } finally {
    cloudSyncInFlight = false;
  }
}

function scheduleCloudSync(context: vscode.ExtensionContext): void {
  const { enabled, intervalMinutes } = cloudConfig();
  if (!enabled) {
    return;
  }
  const intervalMs = intervalMinutes * 60 * 1000;
  const timer = setInterval(() => {
    void runCloudSync(context);
  }, intervalMs);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void runCloudSync(context);
}

function watchTelemetry(context: vscode.ExtensionContext): void {
  const { csvPath, statePath, sqlitePath } = defaultPaths();
  const dir = path.dirname(csvPath);
  let timer: NodeJS.Timeout | undefined;

  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => host?.pushUpdate(), 250);
  };

  if (fs.existsSync(dir)) {
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        if (!filename) {
          schedule();
          return;
        }
        const name = filename.toString();
        if (
          name === "token-telemetry.csv" ||
          name === "token-hook-state.json" ||
          name === "token-telemetry.sqlite" ||
          name.startsWith("token-telemetry.sqlite-")
        ) {
          schedule();
        }
      });
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch {
      /* ignore */
    }
  }

  for (const file of [csvPath, statePath, sqlitePath]) {
    if (fs.existsSync(file)) {
      const w = fs.watch(file, schedule);
      context.subscriptions.push({ dispose: () => w.close() });
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  applyTimeoutSettings(context);
  getTelemetryOutputChannel();

  const queryLimit = vscode.workspace
    .getConfiguration("tokenTelemetry")
    .get<number>("queryLimit", 10_000);
  initTelemetryDataSource(context.extensionPath, queryLimit);
  void migrateSqliteIfNeeded(context.extensionPath);
  void refreshCloudSyncMeta(context, null);

  host = new PanelHost(context.extensionUri, () => cloudSyncState);
  context.subscriptions.push({ dispose: () => (host = undefined) });
  context.subscriptions.push({ dispose: () => disposeTelemetryOutputChannel() });

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenTelemetry.showLog", () => {
      getTelemetryOutputChannel().show(true);
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "tokenTelemetry.usagePanel",
      new SidebarPanelProvider(host),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenTelemetry.refresh", () => {
      host?.pushUpdate();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenTelemetry.syncCloudAgents", async () => {
      await runCloudSync(context);
      host?.pushUpdate();
      const n = cloudSyncState?.lastRunsIngested ?? 0;
      const err = cloudSyncState?.lastError;
      if (err) {
        void vscode.window.showErrorMessage(`Cloud sync failed: ${err}`);
        getTelemetryOutputChannel().show(true);
      } else {
        void vscode.window.showInformationMessage(
          `Cloud sync complete (${n} new run${n === 1 ? "" : "s"}).`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenTelemetry.setCloudApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Cursor Cloud Agents API key",
        prompt:
          "Paste an API key from cursor.com/dashboard/cloud-agents (stored in Secret Storage).",
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) {
        return;
      }
      await setCloudApiKey(context.secrets, key);
      await refreshCloudSyncMeta(context, null);
      host?.pushUpdate();
      void vscode.window.showInformationMessage(
        key.trim()
          ? "Cloud API key saved. Syncing cloud agents…"
          : "Cloud API key cleared."
      );
      if (key.trim()) {
        await runCloudSync(context);
        host?.pushUpdate();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenTelemetry.clearCloudApiKey", async () => {
      await clearCloudApiKey(context.secrets);
      await refreshCloudSyncMeta(context, null);
      host?.pushUpdate();
      void vscode.window.showInformationMessage("Cloud API key cleared.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenTelemetry.open", async () => {
      await vscode.commands.executeCommand("tokenTelemetry.openUsage");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenTelemetry.openUsage", async () => {
      try {
        await vscode.commands.executeCommand("tokenTelemetry.usagePanel.focus");
        return;
      } catch {
        /* fall through */
      }
      try {
        await vscode.commands.executeCommand(
          "workbench.view.extension.tokenTelemetry"
        );
      } catch {
        /* ignore */
      }
      await vscode.commands.executeCommand("tokenTelemetry.usagePanel.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenTelemetry.popOutUsage", () => {
      host?.popOut();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenTelemetry.installHooks", async () => {
      try {
        const result = installHooks(context.extensionPath);
        await migrateSqliteIfNeeded(context.extensionPath);
        const detail = [
          ...result.copied.map((p) => path.basename(p)),
          path.basename(result.hooksJsonPath),
        ].join(", ");
        void vscode.window.showInformationMessage(
          `Token Telemetry hooks installed (${detail}). Reload Cursor if hooks were new.`
        );
        host?.pushUpdate();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logTelemetryError("Hook install failed", msg);
        void vscode.window.showErrorMessage(
          `Token Telemetry hook install failed: ${msg}`
        );
      }
    })
  );

  watchTelemetry(context);
  scheduleCloudSync(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tokenTelemetry.queryLimit")) {
        const limit = vscode.workspace
          .getConfiguration("tokenTelemetry")
          .get<number>("queryLimit", 10_000);
        initTelemetryDataSource(context.extensionPath, limit);
        host?.pushUpdate();
      }
      if (e.affectsConfiguration("tokenTelemetry.dbQueryTimeoutSeconds")) {
        applyTimeoutSettings(context);
      }
    })
  );

  host.pushUpdate();

  if (!hooksInstalled()) {
    void vscode.window
      .showInformationMessage(
        "Token Telemetry: install Cursor hooks for IDE chat usage. Set a Cloud API key to include cloud agents.",
        "Install hooks",
        "Set Cloud API key"
      )
      .then((choice) => {
        if (choice === "Install hooks") {
          void vscode.commands.executeCommand("tokenTelemetry.installHooks");
        } else if (choice === "Set Cloud API key") {
          void vscode.commands.executeCommand("tokenTelemetry.setCloudApiKey");
        }
      });
  }
}

export function deactivate(): void {
  host = undefined;
}
