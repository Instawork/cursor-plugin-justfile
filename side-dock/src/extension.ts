import * as vscode from "vscode";
import { openFilesStrip } from "./explorerStrip";

const ACTIVITY_TREE_VIEW_ID = "side-dock.tree";

type TreeNode =
  | { kind: "empty" }
  | { kind: "folder"; folder: vscode.WorkspaceFolder };

class SideDockTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === "empty") {
      const item = new vscode.TreeItem("Open a folder to use workspace roots here.", vscode.TreeItemCollapsibleState.None);
      item.description = "Side Dock";
      return item;
    }
    const { folder } = element;
    const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = folder.uri;
    item.tooltip = folder.uri.fsPath;
    return item;
  }

  getChildren(element?: TreeNode): vscode.ProviderResult<TreeNode[]> {
    if (element !== undefined) {
      return [];
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      return [{ kind: "empty" }];
    }
    return folders.map((folder) => ({ kind: "folder", folder }));
  }

  getParent(): undefined {
    return undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SideDockTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(ACTIVITY_TREE_VIEW_ID, provider),
    vscode.commands.registerCommand("sideDock.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("sideDock.openFilesStrip", () => openFilesStrip(context)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
  );
}
