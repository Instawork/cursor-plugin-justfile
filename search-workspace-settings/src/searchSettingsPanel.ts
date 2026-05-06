import { basename } from "node:path";
import { existsSync } from "node:fs";
import * as vscode from "vscode";

const VIEW_TYPE = "searchWorkspaceSettings.panel";
export const ACTIVITY_VIEW_ID = "searchWorkspaceSettings.view";
const ROOTS_STATE_KEY = "savedRoots";

type Source = "default" | "user" | "workspace" | "folder";
type Kind = "boolean" | "number" | "enum" | "json";

type SettingDef = {
  id: string;
  label: string;
  section: string;
  key: string;
  kind: Kind;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  enumValues?: string[];
  enumLabels?: string[];
};

type InspectShape = {
  workspaceFolderValue?: unknown;
  workspaceValue?: unknown;
  globalValue?: unknown;
};

type SettingRow = {
  id: string;
  label: string;
  description?: string;
  section: string;
  key: string;
  kind: Kind;
  value: unknown;
  source: Source;
  canClear: boolean;
  min?: number;
  max?: number;
  step?: number;
  enumValues?: string[];
  enumLabels?: string[];
};

type RootPill = {
  path: string;
  label: string;
  active: boolean;
};

type PatternItem = {
  pattern: string;
  enabled: boolean;
};

type PatternGroup = {
  id: string;
  label: string;
  section: string;
  key: string;
  items: PatternItem[];
};

type State = {
  roots: RootPill[];
  patternGroups: PatternGroup[];
  settings: SettingRow[];
};

const SETTINGS: SettingDef[] = [
  { id: "search.useIgnoreFiles", label: "Use ignore files", section: "search", key: "useIgnoreFiles", kind: "boolean" },
  { id: "search.useGlobalIgnoreFiles", label: "Use global ignore files", section: "search", key: "useGlobalIgnoreFiles", kind: "boolean" },
  { id: "search.followSymlinks", label: "Follow symlinks", section: "search", key: "followSymlinks", kind: "boolean" },
  { id: "search.smartCase", label: "Smart case", section: "search", key: "smartCase", kind: "boolean" },
  { id: "search.maxResults", label: "Max results", section: "search", key: "maxResults", kind: "number", min: 1, max: 200000, step: 100 },
  {
    id: "search.collapseResults",
    label: "Collapse results",
    section: "search",
    key: "collapseResults",
    kind: "enum",
    enumValues: ["auto", "alwaysCollapse", "alwaysExpand"],
    enumLabels: ["Auto", "Always collapse", "Always expand"],
  },
  { id: "search.showLineNumbers", label: "Show line numbers", section: "search", key: "showLineNumbers", kind: "boolean" },
  {
    id: "search.sortOrder",
    label: "Sort order",
    section: "search",
    key: "sortOrder",
    kind: "enum",
    enumValues: ["default", "fileNamesOnly", "type", "modified", "countDescending", "countAscending"],
    enumLabels: ["Default", "File names only", "Type", "Modified", "Count desc", "Count asc"],
  },
  {
    id: "search.mode",
    label: "Search mode",
    section: "search",
    key: "mode",
    kind: "enum",
    enumValues: ["view", "reuseEditor", "newEditor"],
    enumLabels: ["Sidebar view", "Reuse editor", "New editor"],
  },
  {
    id: "search.searchEditor.defaultNumberOfContextLines",
    label: "Search editor context lines",
    section: "search",
    key: "searchEditor.defaultNumberOfContextLines",
    kind: "number",
    min: 0,
    max: 200,
    step: 1,
  },
  {
    id: "search.searchEditor.reuseOpenSearchEditor",
    label: "Search editor reuse open",
    section: "search",
    key: "searchEditor.reuseOpenSearchEditor",
    kind: "boolean",
  },
  {
    id: "search.searchEditor.doubleClickBehaviour",
    label: "Search editor double-click",
    section: "search",
    key: "searchEditor.doubleClickBehaviour",
    kind: "enum",
    enumValues: ["selectWord", "goToLocation", "peekDefinition"],
    enumLabels: ["Select word", "Go to location", "Peek definition"],
  },
  {
    id: "workbench.quickOpen.closeOnFocusLost",
    label: "Quick Open close on focus lost",
    section: "workbench",
    key: "quickOpen.closeOnFocusLost",
    kind: "boolean",
  },
  {
    id: "editor.find.seedSearchStringFromSelection",
    label: "Find seed from selection",
    section: "editor",
    key: "find.seedSearchStringFromSelection",
    kind: "enum",
    enumValues: ["never", "selection", "selection-word"],
    enumLabels: ["Never", "Selection", "Selection + word"],
  },
  {
    id: "editor.find.autoFindInSelection",
    label: "Find auto in selection",
    section: "editor",
    key: "find.autoFindInSelection",
    kind: "enum",
    enumValues: ["never", "always", "multiline"],
    enumLabels: ["Never", "Always", "Multiline"],
  },
  { id: "editor.find.loop", label: "Find loop", section: "editor", key: "find.loop", kind: "boolean" },
  { id: "editor.find.cursorMoveOnType", label: "Find cursor move on type", section: "editor", key: "find.cursorMoveOnType", kind: "boolean" },
  { id: "editor.find.addExtraSpaceOnTop", label: "Find add extra space on top", section: "editor", key: "find.addExtraSpaceOnTop", kind: "boolean" },
  { id: "editor.find.smartCase", label: "Find smart case", section: "editor", key: "find.smartCase", kind: "boolean" },
  { id: "editor.wordSeparators", label: "editor.wordSeparators", section: "editor", key: "wordSeparators", kind: "json" },
];

const PATTERN_GROUP_DEFS = [
  { id: "search.include", label: "search.include", section: "search", key: "include" },
  { id: "search.exclude", label: "search.exclude", section: "search", key: "exclude" },
  { id: "files.exclude", label: "files.exclude", section: "files", key: "exclude" },
];

function sourceOf(inspect?: InspectShape): Source {
  if (!inspect) return "default";
  if (inspect.workspaceFolderValue !== undefined) return "folder";
  if (inspect.workspaceValue !== undefined) return "workspace";
  if (inspect.globalValue !== undefined) return "user";
  return "default";
}

function collectSettings(): SettingRow[] {
  return SETTINGS.map((d) => {
    const cfg = vscode.workspace.getConfiguration(d.section);
    const inspect = cfg.inspect(d.key) as InspectShape | undefined;
    const raw = cfg.get(d.key);
    const canClear = !!(inspect && (inspect.workspaceValue !== undefined || inspect.workspaceFolderValue !== undefined));
    const value = d.kind === "json" ? JSON.stringify(typeof raw === "string" ? raw : String(raw ?? "")) : raw;
    return {
      id: d.id,
      label: d.label,
      description: d.description,
      section: d.section,
      key: d.key,
      kind: d.kind,
      value,
      source: sourceOf(inspect),
      canClear,
      min: d.min,
      max: d.max,
      step: d.step,
      enumValues: d.enumValues,
      enumLabels: d.enumLabels,
    };
  });
}

function parsePatternItems(raw: unknown): PatternItem[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const byPattern = new Map<string, boolean>();
  const rec = raw as Record<string, unknown>;
  for (const [keyRaw, val] of Object.entries(rec)) {
    const key = keyRaw.trim();
    const commented = key.startsWith("// ");
    const pattern = commented ? key.slice(3).trim() : key;
    if (!pattern) continue;
    const enabled = commented ? false : val !== false;
    if (byPattern.has(pattern)) {
      // If either form enables the pattern, keep it enabled.
      byPattern.set(pattern, byPattern.get(pattern) === true || enabled);
    } else {
      byPattern.set(pattern, enabled);
    }
  }
  const out: PatternItem[] = [...byPattern.entries()].map(([pattern, enabled]) => ({ pattern, enabled }));
  out.sort((a, b) => a.pattern.localeCompare(b.pattern));
  return out;
}

function serializePatternItems(items: PatternItem[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const byPattern = new Map<string, boolean>();
  for (const item of items) {
    const pattern = item.pattern.trim();
    if (!pattern) continue;
    byPattern.set(pattern, item.enabled);
  }
  for (const [pattern, enabled] of byPattern.entries()) {
    out[pattern] = enabled;
  }
  return out;
}

function readPatternItems(section: string, key: string): PatternItem[] {
  const cfg = vscode.workspace.getConfiguration(section);
  return parsePatternItems(cfg.get<Record<string, unknown>>(key));
}

async function writePatternItems(section: string, key: string, items: PatternItem[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(section);
  await cfg.update(key, serializePatternItems(items), vscode.ConfigurationTarget.Workspace);
}

function readSavedRoots(): string[] {
  const cfg = vscode.workspace.getConfiguration("searchWorkspaceSettings");
  const raw = cfg.get<string[]>(ROOTS_STATE_KEY, []);
  return Array.isArray(raw) ? raw.filter((p) => typeof p === "string") : [];
}

async function saveSavedRoots(paths: string[]): Promise<void> {
  const unique = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  const cfg = vscode.workspace.getConfiguration("searchWorkspaceSettings");
  await cfg.update(ROOTS_STATE_KEY, unique, vscode.ConfigurationTarget.Workspace);
}

function collectRoots(): RootPill[] {
  const excludedPatterns = new Set(
    readPatternItems("search", "exclude")
      .filter((it) => it.enabled)
      .map((it) => it.pattern),
  );
  const active = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  const all = new Set<string>([...active, ...readSavedRoots()]);
  const out: RootPill[] = [];
  for (const path of all) {
    const pattern = rootExcludePattern(path);
    out.push({ path, label: basename(path) || path, active: active.has(path) && !excludedPatterns.has(pattern) });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function collectPatternGroups(): PatternGroup[] {
  return PATTERN_GROUP_DEFS.map((def) => ({ ...def, items: readPatternItems(def.section, def.key) }));
}

function collectState(): State {
  return { roots: collectRoots(), patternGroups: collectPatternGroups(), settings: collectSettings() };
}

function rootExcludePattern(path: string): string {
  return `${basename(path)}/**`;
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

type HostPost = (data: unknown) => Thenable<boolean>;

class SharedHostActions {
  constructor(private readonly postMessage: HostPost) {}

  postState(): void {
    void this.postMessage({ type: "state", state: collectState() });
  }

  async onMessage(msg: Record<string, unknown>): Promise<void> {
    const type = typeof msg.type === "string" ? msg.type : "";
    if (type === "ready") return this.postState();

    if (type === "set") {
      const section = typeof msg.section === "string" ? msg.section : "";
      const key = typeof msg.key === "string" ? msg.key : "";
      const kind = typeof msg.kind === "string" ? msg.kind : "";
      if (!section || !key || !kind) return;
      return this.updateSetting(section, key, kind, msg.value);
    }
    if (type === "clear") {
      const section = typeof msg.section === "string" ? msg.section : "";
      const key = typeof msg.key === "string" ? msg.key : "";
      if (!section || !key) return;
      return this.clearOverrides(section, key);
    }
    if (type === "togglePattern") {
      const section = typeof msg.section === "string" ? msg.section : "";
      const key = typeof msg.key === "string" ? msg.key : "";
      const pattern = typeof msg.pattern === "string" ? msg.pattern.trim() : "";
      const enabled = msg.enabled === true;
      if (!section || !key || !pattern) return;
      return this.togglePattern(section, key, pattern, enabled);
    }
    if (type === "addPattern") {
      const section = typeof msg.section === "string" ? msg.section : "";
      const key = typeof msg.key === "string" ? msg.key : "";
      const pattern = typeof msg.pattern === "string" ? msg.pattern.trim() : "";
      if (!section || !key || !pattern) return;
      return this.addPattern(section, key, pattern);
    }
    if (type === "toggleRoot") {
      const path = typeof msg.path === "string" ? msg.path : "";
      const active = msg.active === true;
      if (!path) return;
      return this.toggleRoot(path, active);
    }
    if (type === "addRoot") return this.addRoot();
  }

  private async updateSetting(section: string, key: string, kind: string, value: unknown): Promise<void> {
    try {
      const cfg = vscode.workspace.getConfiguration(section);
      if (kind === "boolean") {
        if (typeof value !== "boolean") return;
        await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
      } else if (kind === "number") {
        if (typeof value !== "number" || Number.isNaN(value)) return;
        await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
      } else if (kind === "enum") {
        if (typeof value !== "string") return;
        await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
      } else if (kind === "json") {
        if (typeof value !== "string") return;
        const parsed = JSON.parse(value) as unknown;
        await cfg.update(key, String(parsed), vscode.ConfigurationTarget.Workspace);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Could not update ${section}.${key}: ${msg}`);
    }
    this.postState();
  }

  private async clearOverrides(section: string, key: string): Promise<void> {
    try {
      const cfg = vscode.workspace.getConfiguration(section);
      await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const scoped = vscode.workspace.getConfiguration(section, folder.uri);
        await scoped.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Could not clear ${section}.${key}: ${msg}`);
    }
    this.postState();
  }

  private async togglePattern(section: string, key: string, pattern: string, enabled: boolean): Promise<void> {
    try {
      const items = readPatternItems(section, key);
      const idx = items.findIndex((it) => it.pattern === pattern);
      if (idx >= 0) items[idx].enabled = enabled;
      else items.push({ pattern, enabled });
      await writePatternItems(section, key, items);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Could not update ${section}.${key}: ${msg}`);
    }
    this.postState();
  }

  private async addPattern(section: string, key: string, pattern: string): Promise<void> {
    try {
      const items = readPatternItems(section, key);
      const idx = items.findIndex((it) => it.pattern === pattern);
      if (idx >= 0) items[idx].enabled = true;
      else items.push({ pattern, enabled: true });
      await writePatternItems(section, key, items);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Could not add pattern to ${section}.${key}: ${msg}`);
    }
    this.postState();
  }

  private async toggleRoot(path: string, active: boolean): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const idx = folders.findIndex((f) => f.uri.fsPath === path);
    if (active) {
      if (idx < 0) {
        if (!existsSync(path)) {
          void vscode.window.showErrorMessage(`Path does not exist: ${path}`);
          return;
        }
        const ok = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(path) });
        if (!ok) {
          void vscode.window.showErrorMessage(`Could not add workspace root: ${path}`);
          return;
        }
      }
    } else if (idx < 0) {
      // Can't scope search for a root not in workspace; keep behavior predictable.
      return;
    }

    // Root selection is now search-scope only: toggle via search.exclude, not workspace folders.
    const pattern = rootExcludePattern(path);
    const excludeItems = readPatternItems("search", "exclude");
    const excludeIdx = excludeItems.findIndex((it) => it.pattern === pattern);
    if (active) {
      if (excludeIdx >= 0) {
        excludeItems.splice(excludeIdx, 1);
      }
    } else if (excludeIdx >= 0) {
      excludeItems[excludeIdx].enabled = true;
    } else {
      excludeItems.push({ pattern, enabled: true });
    }
    await writePatternItems("search", "exclude", excludeItems);

    await saveSavedRoots([...readSavedRoots(), path]);
    this.postState();
  }

  private async addRoot(): Promise<void> {
    const pick = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Add to workspace",
    });
    if (!pick?.[0]) return;
    await this.toggleRoot(pick[0].fsPath, true);
  }
}

function registerHostRefresh(onRefresh: () => void): vscode.Disposable[] {
  return [
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("search") ||
        e.affectsConfiguration("files") ||
        e.affectsConfiguration("workbench") ||
        e.affectsConfiguration("editor") ||
        e.affectsConfiguration("searchWorkspaceSettings")
      ) {
        onRefresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => onRefresh()),
  ];
}

export class SearchSettingsPanel {
  private static current: SearchSettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly actions: SharedHostActions;

  static show(extensionUri: vscode.Uri): void {
    if (SearchSettingsPanel.current) {
      SearchSettingsPanel.current.panel.reveal(vscode.ViewColumn.One);
      SearchSettingsPanel.current.actions.postState();
      return;
    }
    SearchSettingsPanel.current = new SearchSettingsPanel(extensionUri);
  }

  private constructor(_extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Search & Workspace Settings", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = SearchSettingsPanel.renderHtml(this.panel.webview.cspSource, nonce());
    this.actions = new SharedHostActions((data) => this.panel.webview.postMessage(data));

    this.disposables.push(
      this.panel.onDidDispose(() => {
        for (const d of this.disposables) d.dispose();
        SearchSettingsPanel.current = undefined;
      }),
      this.panel.webview.onDidReceiveMessage((m: unknown) => {
        void this.actions.onMessage(m as Record<string, unknown>);
      }),
      ...registerHostRefresh(() => this.actions.postState()),
    );
  }

  static renderHtml(cspSource: string, n: string): string {
    const csp = `default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${n}';`;
    return `<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);padding:14px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
h1{font-size:14px;margin:0 0 8px 0}
h2{font-size:12px;text-transform:uppercase;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-widget-border);padding-bottom:6px;margin-top:18px}
.hint{font-size:11px;color:var(--vscode-descriptionForeground);margin:6px 0}
.row{display:grid;grid-template-columns:1fr auto;gap:10px;padding:8px 0;border-bottom:1px solid var(--vscode-widget-border)}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.badge{padding:2px 6px;border-radius:4px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px}
input,select,textarea,button{font-family:inherit;font-size:inherit}
input,select,textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-widget-border);border-radius:4px;padding:4px 6px}
textarea{min-width:320px;min-height:72px;font-family:var(--vscode-editor-font-family);font-size:12px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:4px 10px;cursor:pointer}
button.secondary{background:transparent;border:1px solid var(--vscode-widget-border);color:var(--vscode-textLink-foreground)}
.pill-wrap{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.pill{border:1px solid var(--vscode-widget-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:3px 10px;border-radius:999px;cursor:pointer}
.pill.off{opacity:.6;text-decoration:line-through}
.line{display:flex;gap:8px;align-items:center}
.line input{flex:1;min-width:220px}
</style>
</head>
<body>
<h1>Search & Workspace Settings</h1>
<div class="hint">Click a pill to toggle. Inactive patterns are saved as <code>false</code> for that glob.</div>
<div id="app"></div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
let state = { roots: [], patternGroups: [], settings: [] };
const esc = (v) => String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const srcLabel = (s) => s === "folder" ? "Folder" : (s === "workspace" ? "Workspace" : (s === "user" ? "User" : "Default"));
function splitIndex(id){ if(id==="workbench.quickOpen.closeOnFocusLost") return 1; if(id==="editor.find.seedSearchStringFromSelection") return 2; return 0; }
function renderSetting(s){
  let control = "";
  if (s.kind === "boolean") control = '<input type="checkbox" data-kind="boolean" data-section="'+esc(s.section)+'" data-key="'+esc(s.key)+'" '+(s.value===true?'checked':'')+' />';
  else if (s.kind === "number") control = '<input type="number" data-kind="number" data-section="'+esc(s.section)+'" data-key="'+esc(s.key)+'" value="'+esc(s.value??"")+'" />';
  else if (s.kind === "enum") {
    const opts = (s.enumValues||[]).map((v, i) => '<option value="'+esc(v)+'" '+(v===s.value?'selected':'')+'>'+esc((s.enumLabels && s.enumLabels[i]) || v)+'</option>').join("");
    control = '<select data-kind="enum" data-section="'+esc(s.section)+'" data-key="'+esc(s.key)+'">'+opts+'</select>';
  } else control = '<textarea data-kind="json" data-section="'+esc(s.section)+'" data-key="'+esc(s.key)+'">'+esc(s.value??"")+'</textarea><button data-action="apply-json" data-section="'+esc(s.section)+'" data-key="'+esc(s.key)+'">Apply JSON</button>';
  return '<div class="row"><div><div>'+esc(s.label)+'</div>'+(s.description?'<div class="hint">'+esc(s.description)+'</div>':'')+'</div><div class="controls">'+control+'<span class="badge">'+srcLabel(s.source)+'</span>'+(s.canClear?'<button class="secondary" data-action="clear" data-section="'+esc(s.section)+'" data-key="'+esc(s.key)+'">Clear override</button>':'')+'</div></div>';
}
function renderPatterns(g){
  const pills = (g.items||[]).map((it)=>'<button class="pill '+(it.enabled?'':'off')+'" data-action="toggle-pattern" data-section="'+esc(g.section)+'" data-key="'+esc(g.key)+'" data-pattern="'+esc(it.pattern)+'" data-enabled="'+(it.enabled?'0':'1')+'">'+esc(it.pattern)+'</button>').join("") || '<div class="hint">No patterns yet.</div>';
  return '<h2>'+esc(g.label)+'</h2><div class="pill-wrap">'+pills+'</div><div class="line"><input data-input-pattern="'+esc(g.id)+'" placeholder="Add pattern (e.g. **/*.log)" /><button data-action="add-pattern" data-group="'+esc(g.id)+'" data-section="'+esc(g.section)+'" data-key="'+esc(g.key)+'">Add</button></div>';
}
function renderRoots(){
  const pills = (state.roots||[]).map((r)=>'<button class="pill '+(r.active?'':'off')+'" data-action="toggle-root" data-path="'+esc(r.path)+'" data-active="'+(r.active?'0':'1')+'">'+esc(r.label)+'</button>').join("") || '<div class="hint">No roots.</div>';
  return '<h2>Workspace Roots</h2><div class="pill-wrap">'+pills+'</div><div class="line"><button data-action="add-root">Add folder to workspace...</button></div>';
}
function render(){
  const groups = [[],[],[]];
  for (const s of (state.settings||[])) groups[splitIndex(s.id)].push(renderSetting(s));
  const patternHtml = (state.patternGroups||[]).map(renderPatterns).join("");
  document.getElementById("app").innerHTML = renderRoots() + patternHtml + '<h2>Find in Files & Search Editor</h2>'+groups[0].join("") + '<h2>Quick Open</h2>'+groups[1].join("") + '<h2>Editor Find</h2>'+groups[2].join("");
  bind();
}
function bind(){
  document.querySelectorAll('input[data-kind="boolean"]').forEach((el)=>el.addEventListener("change",()=>vscode.postMessage({type:"set",kind:"boolean",section:el.dataset.section,key:el.dataset.key,value:el.checked})));
  document.querySelectorAll('input[data-kind="number"]').forEach((el)=>el.addEventListener("change",()=>vscode.postMessage({type:"set",kind:"number",section:el.dataset.section,key:el.dataset.key,value:Number(el.value)})));
  document.querySelectorAll('select[data-kind="enum"]').forEach((el)=>el.addEventListener("change",()=>vscode.postMessage({type:"set",kind:"enum",section:el.dataset.section,key:el.dataset.key,value:el.value})));
  document.querySelectorAll('button[data-action="apply-json"]').forEach((el)=>el.addEventListener("click",()=>{ const q='textarea[data-section="'+el.dataset.section+'"][data-key="'+el.dataset.key+'"]'; const t=document.querySelector(q); if(t){ vscode.postMessage({type:"set",kind:"json",section:el.dataset.section,key:el.dataset.key,value:t.value}); }}));
  document.querySelectorAll('button[data-action="clear"]').forEach((el)=>el.addEventListener("click",()=>vscode.postMessage({type:"clear",section:el.dataset.section,key:el.dataset.key})));
  document.querySelectorAll('button[data-action="toggle-pattern"]').forEach((el)=>el.addEventListener("click",()=>vscode.postMessage({type:"togglePattern",section:el.dataset.section,key:el.dataset.key,pattern:el.dataset.pattern,enabled:el.dataset.enabled==="1"})));
  document.querySelectorAll('button[data-action="add-pattern"]').forEach((el)=>el.addEventListener("click",()=>{ const input=document.querySelector('input[data-input-pattern="'+el.dataset.group+'"]'); if(!input || !input.value.trim()) return; vscode.postMessage({type:"addPattern",section:el.dataset.section,key:el.dataset.key,pattern:input.value.trim()}); input.value=""; }));
  document.querySelectorAll('button[data-action="toggle-root"]').forEach((el)=>el.addEventListener("click",()=>vscode.postMessage({type:"toggleRoot",path:el.dataset.path,active:el.dataset.active==="1"})));
  document.querySelectorAll('button[data-action="add-root"]').forEach((el)=>el.addEventListener("click",()=>vscode.postMessage({type:"addRoot"})));
}
window.addEventListener("message",(event)=>{ const m = event.data; if(m&&m.type==="state"){ state=m.state; render(); }});
vscode.postMessage({type:"ready"});
render();
</script>
</body>
</html>`;
  }
}

export class SearchSettingsActivityViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private actions: SharedHostActions | undefined;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = SearchSettingsPanel.renderHtml(view.webview.cspSource, nonce());
    this.actions = new SharedHostActions((data) => view.webview.postMessage(data));
    this.disposables.push(
      view.onDidDispose(() => { this.view = undefined; }),
      view.webview.onDidReceiveMessage((m: unknown) => { if (this.actions) void this.actions.onMessage(m as Record<string, unknown>); }),
      ...registerHostRefresh(() => this.actions?.postState()),
    );
    this.actions.postState();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
