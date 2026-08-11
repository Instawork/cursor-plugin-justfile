import * as path from "path";
import * as vscode from "vscode";
import {
  CURSOR_WORKFLOW_GLOBS,
  isUnderCursorDir,
  sortWorkflowPaths,
  workflowLabel,
} from "./discoverWorkflows";
import { showLog } from "./log";
import { openInStudio, watchMmdTextEditors } from "./openInStudio";
import {
  getActiveWorkflowPanel,
  runStudioCommand,
  WorkflowEditorProvider,
} from "./workflowEditor";
import type { HostCommandName } from "./types";

const OPEN_CMD = "workflowStudio.open";
const OPEN_FILE_CMD = "workflowStudio.openFile";
const OPEN_CURSOR_CMD = "workflowStudio.openCursorWorkflow";

const STUDIO_COMMANDS: { id: string; command: HostCommandName }[] = [
  { id: "workflowStudio.bindSelectedNode", command: "bindSelectedNode" },
  { id: "workflowStudio.nextUnbound", command: "nextUnbound" },
  { id: "workflowStudio.focusRail", command: "focusRail" },
  { id: "workflowStudio.focusGraph", command: "focusGraph" },
  { id: "workflowStudio.focusPrompt", command: "focusPrompt" },
];

async function findCursorWorkflowUris(): Promise<vscode.Uri[]> {
  const found: vscode.Uri[] = [];
  for (const pattern of CURSOR_WORKFLOW_GLOBS) {
    const matches = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 200);
    found.push(...matches);
  }
  const unique = new Map<string, vscode.Uri>();
  for (const uri of found) {
    unique.set(uri.fsPath, uri);
  }
  const roots = workspaceRoots();
  const sorted = sortWorkflowPaths([...unique.keys()], roots);
  return sorted.map((p) => unique.get(p)!);
}

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

async function pickAndOpenWorkflow(preferCursorOnly: boolean): Promise<void> {
  const cursorUris = await findCursorWorkflowUris();
  const roots = workspaceRoots();

  type Item = vscode.QuickPickItem & { uri?: vscode.Uri; browse?: boolean };
  const items: Item[] = [];

  if (cursorUris.length > 0) {
    items.push({
      label: "Installed under .cursor",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const uri of cursorUris) {
      items.push({
        label: path.basename(uri.fsPath),
        description: workflowLabel(uri.fsPath, roots),
        uri,
      });
    }
  }

  if (!preferCursorOnly || cursorUris.length === 0) {
    items.push({
      label: "Browse…",
      description: "Pick any .mmd file",
      browse: true,
    });
  } else {
    items.push({
      label: "Browse other .mmd…",
      description: "Outside .cursor",
      browse: true,
    });
  }

  if (items.length === 1 && items[0].browse) {
    await browseAndOpen();
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: preferCursorOnly
      ? "Workflow Studio · .cursor workflows"
      : "Workflow Studio · Open workflow",
    matchOnDescription: true,
    placeHolder:
      cursorUris.length > 0
        ? "Workflows under .cursor are listed first"
        : "No .mmd under .cursor yet — browse or install a pack",
  });
  if (!picked) {
    return;
  }
  if (picked.browse) {
    await browseAndOpen();
    return;
  }
  if (picked.uri) {
    await openInStudio(picked.uri);
  }
}

async function browseAndOpen(): Promise<void> {
  const defaultUri = await defaultBrowseUri();
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Open in Workflow Studio",
    filters: { "Mermaid workflow": ["mmd"] },
    defaultUri,
  });
  const file = picked?.[0];
  if (!file) {
    return;
  }
  await openInStudio(file);
}

async function defaultBrowseUri(): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const cursorRoot = vscode.Uri.joinPath(folder.uri, ".cursor");
  try {
    await vscode.workspace.fs.stat(cursorRoot);
    return cursorRoot;
  } catch {
    return folder.uri;
  }
}

function watchCursorWorkflows(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration("workflowStudio");
  if (!cfg().get<boolean>("notifyOnNewCursorWorkflow", true)) {
    return;
  }

  const watcher = vscode.workspace.createFileSystemWatcher(".cursor/**/*.mmd");
  const offered = new Set<string>();

  const onCreate = (uri: vscode.Uri) => {
    const roots = workspaceRoots();
    if (!isUnderCursorDir(uri.fsPath, roots) || offered.has(uri.fsPath)) {
      return;
    }
    offered.add(uri.fsPath);
    const label = workflowLabel(uri.fsPath, roots);
    void vscode.window
      .showInformationMessage(
        `Workflow Studio found a new graph under .cursor: ${label}`,
        "Open",
      )
      .then((choice) => {
        if (choice === "Open") {
          void openInStudio(uri);
        }
      });
  };

  watcher.onDidCreate(onCreate);
  context.subscriptions.push(watcher);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(WorkflowEditorProvider.register(context));
  watchMmdTextEditors(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_CMD, async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || !target.fsPath.toLowerCase().endsWith(".mmd")) {
        await vscode.commands.executeCommand(OPEN_FILE_CMD);
        return;
      }
      await openInStudio(target);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_FILE_CMD, async () => {
      await pickAndOpenWorkflow(false);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_CURSOR_CMD, async () => {
      await pickAndOpenWorkflow(true);
    }),
  );

  for (const entry of STUDIO_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(entry.id, () => runStudioCommand(entry.command)),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("workflowStudio.showLog", () => showLog()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workflowStudio.bindPromptsNow", async () => {
      const panel = getActiveWorkflowPanel();
      if (!panel) {
        void vscode.window.showInformationMessage("Open a .mmd in Workflow Studio first.");
        return;
      }
      await panel.bindPromptsNow();
    }),
  );

  watchCursorWorkflows(context);

  const key = "workflowStudio.didShowHowTo";
  if (!context.globalState.get(key)) {
    void context.globalState.update(key, true);
    void vscode.window
      .showInformationMessage(
        "Workflow Studio opens .mmd graphs (including packs under .cursor). Use “Open Cursor Workflow…” to list installed graphs.",
        "Open Cursor Workflow…",
      )
      .then((choice) => {
        if (choice === "Open Cursor Workflow…") {
          void vscode.commands.executeCommand(OPEN_CURSOR_CMD);
        }
      });
  }
}

export function deactivate(): void {
  // no-op
}
