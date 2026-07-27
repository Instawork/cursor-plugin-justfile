import * as vscode from "vscode";
import { VIEW_TYPE, WorkflowEditorProvider } from "./workflowEditor";

const OPEN_CMD = "workflowStudio.open";
const OPEN_FILE_CMD = "workflowStudio.openFile";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(WorkflowEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_CMD, async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || !target.fsPath.toLowerCase().endsWith(".mmd")) {
        await vscode.commands.executeCommand(OPEN_FILE_CMD);
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_FILE_CMD, async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Open in Workflow Studio",
        filters: { "Mermaid workflow": ["mmd"] },
      });
      const file = picked?.[0];
      if (!file) {
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", file, VIEW_TYPE);
    }),
  );

  const key = "workflowStudio.didShowHowTo";
  if (!context.globalState.get(key)) {
    void context.globalState.update(key, true);
    void vscode.window
      .showInformationMessage(
        "Workflow Studio is installed. Open a .mmd via Command Palette: “Workflow Studio: Open Workflow File…” (or right-click a .mmd → Open in Workflow Studio).",
        "Open a .mmd…",
      )
      .then((choice) => {
        if (choice === "Open a .mmd…") {
          void vscode.commands.executeCommand(OPEN_FILE_CMD);
        }
      });
  }
}

export function deactivate(): void {
  // no-op
}
