import * as vscode from "vscode";
import { ACTIVITY_VIEW_ID, SearchSettingsActivityViewProvider, SearchSettingsPanel } from "./searchSettingsPanel";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SearchSettingsActivityViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ACTIVITY_VIEW_ID, provider),
    vscode.commands.registerCommand("searchWorkspaceSettings.openPanel", () =>
      SearchSettingsPanel.show(context.extensionUri),
    ),
    provider,
  );
}
