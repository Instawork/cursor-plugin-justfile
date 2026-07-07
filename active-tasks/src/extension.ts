import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { activeTasksDbPath, openActiveTasksDb, seedActiveWorkIfEmpty } from "./activeTasksStore";
import { clearCloudApiKey, setCloudApiKey } from "./cloudSecrets";
import { invalidateTaskDiscoveryCache } from "./discovery";
import { hooksInstalled, installHooks } from "./installHooks";
import { PanelHost, SidebarPanelProvider } from "./panelHost";

let host: PanelHost | undefined;

function watchActiveTasks(context: vscode.ExtensionContext): void {
  let timer: NodeJS.Timeout | undefined;

  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(
      () => host?.pushUpdate({ skipDiscovery: true }),
      250
    );
  };

  const dbPath = activeTasksDbPath();
  const dbDir = path.dirname(dbPath);
  const dbBase = path.basename(dbPath);
  const walName = `${dbBase}-wal`;

  const watchPath = (target: string) => {
    if (!fs.existsSync(target)) {
      return;
    }
    const w = fs.watch(target, schedule);
    context.subscriptions.push({ dispose: () => w.close() });
  };

  watchPath(dbPath);
  watchPath(path.join(dbDir, walName));

  if (fs.existsSync(dbDir)) {
    const dirWatcher = fs.watch(dbDir, (_event, name) => {
      if (name === dbBase || name === walName) {
        schedule();
      }
    });
    context.subscriptions.push({ dispose: () => dirWatcher.close() });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  host = new PanelHost(context.extensionUri, context);
  context.subscriptions.push({ dispose: () => host?.dispose() });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "activeTasks.panel",
      new SidebarPanelProvider(host),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("activeTasks.refresh", () => {
      invalidateTaskDiscoveryCache();
      if (seedActiveWorkIfEmpty() >= 0) {
        host?.pushUpdate({ forceDiscovery: true });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("activeTasks.setCloudApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Cursor Cloud Agents API key",
        prompt:
          "Paste an API key from cursor.com/dashboard/cloud-agents (shared with Token Telemetry if set there).",
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) {
        return;
      }
      await setCloudApiKey(context.secrets, key);
      invalidateTaskDiscoveryCache();
      host?.pushUpdate({ forceDiscovery: true });
      void vscode.window.showInformationMessage(
        key.trim()
          ? "Cloud API key saved. Scanning cloud agents…"
          : "Cloud API key cleared."
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("activeTasks.clearCloudApiKey", async () => {
      await clearCloudApiKey(context.secrets);
      invalidateTaskDiscoveryCache();
      host?.pushUpdate({ forceDiscovery: true });
      void vscode.window.showInformationMessage("Active Tasks cloud API key cleared.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("activeTasks.open", async () => {
      try {
        await vscode.commands.executeCommand("activeTasks.panel.focus");
        return;
      } catch {
        /* fall through */
      }
      try {
        await vscode.commands.executeCommand(
          "workbench.view.extension.activeTasks"
        );
      } catch {
        /* ignore */
      }
      await vscode.commands.executeCommand("activeTasks.panel.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("activeTasks.popOut", () => {
      if (!host) {
        void vscode.window.showErrorMessage(
          "Active Tasks is not ready yet. Run “Developer: Reload Window” and try again."
        );
        return;
      }
      try {
        host.popOut();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Active Tasks pop out failed: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("activeTasks.installHooks", async () => {
      try {
        const result = installHooks(context.extensionPath);
        const detail = [
          ...result.copied.map((p) => path.basename(p)),
          path.basename(result.hooksJsonPath),
        ].join(", ");
        void vscode.window.showInformationMessage(
          `Active Tasks hooks installed (${detail}). Reload Cursor if hooks were new.`
        );
        host?.pushUpdate();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Active Tasks hook install failed: ${msg}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("activeTasks.openDatabase", async () => {
      const db = activeTasksDbPath();
      await vscode.window.showTextDocument(vscode.Uri.file(db), {
        preview: false,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("activeTasks.consolidateWithAgent", () => {
      if (!host) {
        void vscode.window.showErrorMessage("Active Tasks is not ready.");
        return;
      }
      void host.copyAgentConsolidationBrief();
    })
  );

  let dbReady = false;
  try {
    openActiveTasksDb();
    const rowCount = seedActiveWorkIfEmpty();
    if (rowCount === 0) {
      void vscode.window.showWarningMessage(
        `Active Tasks: no rows in ${activeTasksDbPath()}. Add tasks in the panel or restore active-tasks.toml, then use Refresh.`
      );
    }
    dbReady = true;
    watchActiveTasks(context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `Active Tasks database failed to open: ${msg}`
    );
  }

  const discoveryTimer = setInterval(() => {
    if (dbReady) {
      host?.pushUpdate({ forceDiscovery: true });
    }
  }, 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(discoveryTimer) });

  try {
    host?.pushUpdate({ forceDiscovery: dbReady });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Active Tasks failed to load: ${msg}`);
  }

  if (!hooksInstalled()) {
    void vscode.window
      .showInformationMessage(
        "Active Tasks: install Cursor hooks to inject session context.",
        "Install hooks"
      )
      .then((choice) => {
        if (choice === "Install hooks") {
          void vscode.commands.executeCommand("activeTasks.installHooks");
        }
      });
  }
}

export function deactivate(): void {
  host = undefined;
}
