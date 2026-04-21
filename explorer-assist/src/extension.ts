import * as vscode from "vscode";

const CONFIG_SECTION = "explorerAssist";

/** Minimum time between successful runs of explorer assist (sidebar updates). */
const MIN_RUN_INTERVAL_MS = 30_000;

const SEARCH_VIEWLET = "workbench.view.search";

const SEARCH_RELATED_COMMANDS = new Set<string>([
  SEARCH_VIEWLET,
  "workbench.action.findInFiles",
  "workbench.action.replaceInFiles",
]);

/** Best-effort: updated when `commands.onDidExecuteCommand` exists (see `wireSidebarViewletTracking`). */
let trackedSidebarViewlet: string | undefined;

let assistRunChain: Promise<void> = Promise.resolve();

function configurationSaveTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function collectOpenFileUris(): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  const seen = new Set<string>();
  const add = (u: vscode.Uri | undefined): void => {
    if (!u || u.scheme !== "file") {
      return;
    }
    const key = u.toString();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    uris.push(u);
  };

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText) {
        add(input.uri);
      } else if (input instanceof vscode.TabInputTextDiff) {
        add(input.modified);
        add(input.original);
      } else if (input instanceof vscode.TabInputNotebook) {
        add(input.uri);
      } else if (input instanceof vscode.TabInputNotebookDiff) {
        add(input.modified);
        add(input.original);
      } else if (input instanceof vscode.TabInputCustom) {
        add(input.uri);
      }
    }
  }
  return uris;
}

async function setAssistConfig(key: "focusOnExplorer" | "autoCollapse", value: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(key, value, configurationSaveTarget());
}

function editorDocumentKey(editor: vscode.TextEditor): string {
  return editor.document.uri.toString();
}

function executedCommandId(e: unknown): string {
  if (!e || typeof e !== "object") {
    return "";
  }
  const rec = e as Record<string, unknown>;
  if (typeof rec.commandId === "string") {
    return rec.commandId;
  }
  if (typeof rec.command === "string") {
    return rec.command;
  }
  return "";
}

/**
 * Tracks the primary sidebar view container when the host exposes `commands.onDidExecuteCommand`
 * (not in stable typings, but present in some VS Code/Cursor builds). If absent, search gating is a no-op.
 */
function wireSidebarViewletTracking(context: vscode.ExtensionContext): void {
  const commandsApi = vscode.commands as unknown as {
    onDidExecuteCommand?: (listener: (e: unknown) => void) => vscode.Disposable;
  };

  if (typeof commandsApi.onDidExecuteCommand !== "function") {
    return;
  }

  context.subscriptions.push(
    commandsApi.onDidExecuteCommand((e) => {
      const id = executedCommandId(e);
      if (!id) {
        return;
      }
      if (SEARCH_RELATED_COMMANDS.has(id)) {
        trackedSidebarViewlet = SEARCH_VIEWLET;
        return;
      }
      if (id.startsWith("workbench.view.")) {
        trackedSidebarViewlet = id;
      }
    }),
  );
}

function isSearchActivityViewOpen(): boolean {
  return trackedSidebarViewlet === SEARCH_VIEWLET;
}

/** True when the focused editor tab is a Search Editor (not a normal workspace file). */
function isSearchEditorTab(editor: vscode.TextEditor): boolean {
  const { document } = editor;
  const u = document.uri;
  if (u.scheme === "search-editor") {
    return true;
  }
  if (u.scheme === "file" && /\.code-search$/i.test(u.fsPath)) {
    return true;
  }
  if (document.languageId === "search-editor") {
    return true;
  }
  return false;
}

function shouldSkipForSearch(editor: vscode.TextEditor): boolean {
  return isSearchEditorTab(editor) || isSearchActivityViewOpen();
}

async function runExplorerAssist(): Promise<void> {
  const active = vscode.window.activeTextEditor;
  if (active && isSearchEditorTab(active)) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const focusOnExplorer = cfg.get<boolean>("focusOnExplorer", true);
  const autoCollapse = cfg.get<boolean>("autoCollapse", true);
  if (!focusOnExplorer && !autoCollapse) {
    return;
  }

  if (focusOnExplorer) {
    await vscode.commands.executeCommand("workbench.view.explorer");
  }

  if (autoCollapse) {
    if (!focusOnExplorer) {
      await vscode.commands.executeCommand("workbench.view.explorer");
    }
    await vscode.commands.executeCommand("workbench.files.action.collapseExplorerFolders");
    for (const uri of collectOpenFileUris()) {
      await vscode.commands.executeCommand("revealInExplorer", uri);
    }
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }
}

export function activate(context: vscode.ExtensionContext): void {
  wireSidebarViewletTracking(context);

  let hadActiveEditor = false;
  let lastActiveDocumentKey: string | undefined;
  let lastSuccessfulAssistRunAt = 0;

  const considerRun = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      hadActiveEditor = false;
      return;
    }

    const key = editorDocumentKey(editor);
    const firstEditorFocus = !hadActiveEditor;
    const fileInFocusChanged =
      hadActiveEditor && lastActiveDocumentKey !== undefined && lastActiveDocumentKey !== key;

    if (!firstEditorFocus && !fileInFocusChanged) {
      return;
    }

    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!cfg.get<boolean>("focusOnExplorer", true) && !cfg.get<boolean>("autoCollapse", true)) {
      return;
    }

    if (shouldSkipForSearch(editor)) {
      return;
    }

    hadActiveEditor = true;
    lastActiveDocumentKey = key;

    assistRunChain = assistRunChain
      .then(async () => {
        if (Date.now() - lastSuccessfulAssistRunAt < MIN_RUN_INTERVAL_MS) {
          return;
        }
        await runExplorerAssist();
        lastSuccessfulAssistRunAt = Date.now();
      })
      .then(undefined, () => undefined);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("explorerAssist.focusOnExplorer.enable", () =>
      setAssistConfig("focusOnExplorer", true),
    ),
    vscode.commands.registerCommand("explorerAssist.focusOnExplorer.disable", () =>
      setAssistConfig("focusOnExplorer", false),
    ),
    vscode.commands.registerCommand("explorerAssist.autoCollapse.enable", () =>
      setAssistConfig("autoCollapse", true),
    ),
    vscode.commands.registerCommand("explorerAssist.autoCollapse.disable", () =>
      setAssistConfig("autoCollapse", false),
    ),
    vscode.window.onDidChangeActiveTextEditor(() => {
      considerRun();
    }),
  );
}
