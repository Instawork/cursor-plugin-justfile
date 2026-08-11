import * as fs from "fs";
import * as path from "path";

export interface WebviewLike {
  cspSource: string;
}

export interface ExtensionUriLike {
  fsPath: string;
}

function joinUri(extensionUri: ExtensionUriLike, ...parts: string[]): { fsPath: string } {
  return { fsPath: path.join(extensionUri.fsPath, ...parts) };
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

/** Read compiled pure helpers and strip CommonJS so they can run inlined in the webview. */
function loadBrowserHelper(extensionUri: ExtensionUriLike, baseName: string): string {
  const candidates = [
    path.join(extensionUri.fsPath, "out", `${baseName}.js`),
    path.join(extensionUri.fsPath, "media", `${baseName}.js`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, "utf8");
      return wrapCommonJs(raw, baseName);
    }
  }
  return `window.__WS_${baseName}__ = {};`;
}

function wrapCommonJs(source: string, globalKey: string): string {
  return `
(function () {
  var exports = {};
  var module = { exports: exports };
  ${source}
  window.__WS_${globalKey}__ = module.exports;
})();
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Minimal page shown when the host fails before the full editor can load. */
export function buildFatalHtml(opts: {
  title: string;
  message: string;
  detail?: string;
  version?: string;
  fileName?: string;
}): string {
  const title = escapeHtml(opts.title);
  const message = escapeHtml(opts.message);
  const detail = escapeHtml(opts.detail || "");
  const version = escapeHtml(opts.version || "unknown");
  const fileName = escapeHtml(opts.fileName || "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Workflow Studio — failed</title>
  <style>
    :root { color-scheme: dark light; }
    body {
      margin: 0; padding: 24px;
      font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
      background: #0f1216; color: #d7dde6;
    }
    h1 { font-size: 16px; margin: 0 0 8px; color: #e4635e; }
    .meta { color: #8b95a7; margin-bottom: 16px; }
    .msg { margin: 0 0 12px; }
    pre {
      margin: 0; padding: 12px; overflow: auto;
      background: #171b22; border: 1px solid #2a313d; border-radius: 6px;
      white-space: pre-wrap; word-break: break-word; font-size: 12px;
    }
    .hint { margin-top: 16px; color: #8b95a7; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="meta">version ${version}${fileName ? ` · ${fileName}` : ""}</div>
  <p class="msg">${message}</p>
  ${detail ? `<pre>${detail}</pre>` : ""}
  <p class="hint">Open the <strong>Workflow Studio</strong> output channel
  (<code>Workflow Studio: Show Log</code>) for the same stack.
  Then <code>Developer: Reload Window</code> after fixing or reinstalling.</p>
</body>
</html>`;
}

export function buildWebviewHtml(
  webview: WebviewLike,
  extensionUri: ExtensionUriLike,
  beautifulMermaidUri: string,
): string {
  const mediaRoot = joinUri(extensionUri, "media");
  const stylePath = path.join(mediaRoot.fsPath, "editor.css");
  const scriptPath = path.join(mediaRoot.fsPath, "editor.js");
  const css = fs.readFileSync(stylePath, "utf8");
  const script = fs.readFileSync(scriptPath, "utf8");
  const panZoomHelper = loadBrowserHelper(extensionUri, "panZoom");
  const railModelHelper = loadBrowserHelper(extensionUri, "railModel");
  const n = nonce();

  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline' 'self'`,
    `script-src 'nonce-${n}' ${webview.cspSource} 'unsafe-eval' 'self' blob:`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource} data: 'self'`,
    `worker-src ${webview.cspSource} blob: 'self'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Workflow Studio</title>
  <style nonce="${n}">${css}</style>
</head>
<body>
  <div id="bootError" class="error-banner hidden" role="alert"></div>
  <header class="topbar">
    <div class="brand">Workflow Studio</div>
    <div class="file-label" id="fileLabel">Rendering…</div>
    <div class="status-chips" id="statusChips" aria-live="polite">
      <span class="status-chip" id="graphStatusChip" data-dirty="false" title="Workflow .mmd">graph: saved</span>
      <span class="status-chip" id="promptStatusChip" data-status="idle" title="Step prompt">prompt: idle</span>
    </div>
  </header>
  <div class="layout">
    <aside class="rail" aria-label="Structure">
      <div class="subhead">
        <div class="pane-title">Structure</div>
        <button type="button" id="openMmdBtn" title="Open .mmd as text">.mmd</button>
      </div>
      <div class="rail-filter-wrap">
        <input type="search" id="railFilter" class="rail-filter" placeholder="Filter steps…" aria-label="Filter structure" />
      </div>
      <div class="rail-list" id="rail" role="listbox" aria-label="Workflow steps">
        <div class="empty" id="railEmpty">Rendering…</div>
      </div>
    </aside>
    <section class="graph-pane" aria-label="Graph">
      <div class="subhead">
        <div class="pane-title">Graph</div>
        <div class="graph-toolbar" role="toolbar" aria-label="Graph zoom">
          <button type="button" id="zoomFit" title="Fit">Fit</button>
          <button type="button" id="zoomReset" title="100%">100%</button>
          <button type="button" id="zoomIn" title="Zoom in">+</button>
          <button type="button" id="zoomOut" title="Zoom out">−</button>
        </div>
      </div>
      <div id="graph" class="graph" tabindex="0"><div class="loading-chip">Rendering…</div></div>
      <div id="graphError" class="error-banner hidden" role="alert"></div>
    </section>
    <section class="prompt-pane" aria-label="Step prompt">
      <div class="prompt-header">
        <div class="prompt-header-main">
          <div class="pane-title" id="promptTitle" aria-live="polite">Step</div>
          <div class="path" id="promptPath"></div>
        </div>
        <div class="prompt-actions">
          <button type="button" id="openPromptBtn" title="Open in editor" disabled>Open</button>
          <button type="button" id="revealPromptBtn" title="Reveal in explorer" disabled>Reveal</button>
          <button type="button" id="previewPromptBtn" title="Markdown preview" disabled>Preview</button>
          <div class="status" id="saveStatus" data-status="idle">idle</div>
        </div>
      </div>
      <div id="conflictBanner" class="conflict-banner hidden" role="alert">
        <span id="conflictText">Disk changed while editing. Keep yours or load disk?</span>
        <div class="conflict-actions">
          <button type="button" id="keepMine" class="primary">Keep yours</button>
          <button type="button" id="loadDisk">Load disk</button>
        </div>
      </div>
      <div id="promptError" class="error-banner hidden" role="alert"></div>
      <div id="bindCard" class="bind-card hidden">
        <h3 id="bindCardTitle">Bind prompt</h3>
        <p id="bindCardBody">Attach a markdown prompt to this step.</p>
        <div class="bind-actions">
          <button type="button" id="bindCreateBtn" class="primary">Create prompt file</button>
          <button type="button" id="bindLinkBtn">Link existing…</button>
          <button type="button" id="bindOpenMmdBtn">Open .mmd as text</button>
        </div>
      </div>
      <div id="emptyCard" class="empty-card hidden">
        <h3>No steps yet</h3>
        <p>Add nodes to your .mmd, or insert a starter workflow with three bound steps.</p>
        <div class="empty-actions">
          <button type="button" id="insertStarterBtn" class="primary">Insert starter workflow</button>
          <button type="button" id="emptyOpenMmdBtn">Open .mmd as text</button>
        </div>
      </div>
      <textarea id="promptEditor" spellcheck="false" aria-label="Prompt markdown" disabled></textarea>
      <div class="footer" id="promptFooter">Select a bound node to edit its prompt.</div>
    </section>
  </div>
  <script nonce="${n}">window.__WORKFLOW_STUDIO_BM_URI__ = ${JSON.stringify(beautifulMermaidUri)};</script>
  <script nonce="${n}">${panZoomHelper}</script>
  <script nonce="${n}">${railModelHelper}</script>
  <script nonce="${n}">${script}</script>
</body>
</html>`;
}
