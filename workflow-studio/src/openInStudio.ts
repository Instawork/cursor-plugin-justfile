import * as vscode from "vscode";
import { formatError, logError, logInfo, logWarn, showLog } from "./log";
import { getActiveWorkflowPanel, openStudioWebviewFallback, VIEW_TYPE } from "./workflowEditor";

const upgrading = new Set<string>();
const fallbackUris = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMmdUri(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && uri.fsPath.toLowerCase().endsWith(".mmd");
}

function studioMountedFor(uri: vscode.Uri): boolean {
  const panel = getActiveWorkflowPanel();
  return Boolean(panel && panel.document.uri.toString() === uri.toString());
}

/**
 * Open a workflow in Studio. Preloads the text model (Cursor often asserts when
 * CustomTextEditor opens before a document exists), then openWith. If the custom
 * editor never mounts, fall back to a plain WebviewPanel on the same document.
 */
export async function openInStudio(uri: vscode.Uri): Promise<void> {
  if (!isMmdUri(uri)) {
    logWarn(`openInStudio ignored non-.mmd uri: ${uri.toString()}`);
    return;
  }

  const key = uri.toString();
  if (upgrading.has(key)) {
    return;
  }
  upgrading.add(key);

  try {
    logInfo(`openInStudio ${uri.fsPath}`);
    const document = await vscode.workspace.openTextDocument(uri);

    if (studioMountedFor(document.uri)) {
      getActiveWorkflowPanel()?.webviewPanel.reveal(undefined, false);
      return;
    }

    if (fallbackUris.has(key)) {
      await openStudioWebviewFallback(document);
      return;
    }

    try {
      await vscode.commands.executeCommand("vscode.openWith", document.uri, VIEW_TYPE);
    } catch (err) {
      logError(`openWith threw for ${document.uri.fsPath}`, err);
      fallbackUris.add(key);
      await openStudioWebviewFallback(document);
      void vscode.window
        .showWarningMessage(
          `Workflow Studio custom editor failed; opened fallback view for ${document.fileName}.`,
          "Show Log",
        )
        .then((choice) => {
          if (choice === "Show Log") {
            showLog();
          }
        });
      return;
    }

    // Cursor may fail setInput without rejecting the command promise.
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      if (studioMountedFor(document.uri)) {
        logInfo(`openInStudio mounted custom editor for ${document.fileName}`);
        return;
      }
    }

    logWarn(
      `openWith did not mount Studio for ${document.uri.fsPath}; using webview fallback. ${formatError(new Error("mount timeout"))}`,
    );
    fallbackUris.add(key);
    await openStudioWebviewFallback(document);
  } finally {
    setTimeout(() => upgrading.delete(key), 1500);
  }
}

/** When a .mmd opens as a normal text tab, upgrade it to Studio once. */
export function watchMmdTextEditors(context: vscode.ExtensionContext): void {
  const tryUpgrade = (editor: vscode.TextEditor | undefined) => {
    if (!editor) {
      return;
    }
    const uri = editor.document.uri;
    if (!isMmdUri(uri)) {
      return;
    }
    const key = uri.toString();
    if (upgrading.has(key)) {
      return;
    }
    if (studioMountedFor(uri)) {
      return;
    }
    void openInStudio(uri);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => tryUpgrade(editor)),
  );

  // Cold start: file already focused as text.
  tryUpgrade(vscode.window.activeTextEditor);
}
