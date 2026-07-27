import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  cacheKey: string,
): string {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media");
  const stylePath = path.join(mediaRoot.fsPath, "editor.css");
  const scriptPath = path.join(mediaRoot.fsPath, "editor.js");
  const css = fs.readFileSync(stylePath, "utf8");
  const script = fs.readFileSync(scriptPath, "utf8");
  const mermaidUri = webview
    .asWebviewUri(vscode.Uri.joinPath(mediaRoot, "mermaid.min.js"))
    .with({ query: cacheKey });
  const n = nonce();

  // 'self' + blob: needed on newer Electron/Cursor webviews; unsafe-eval for Mermaid.
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
    <div class="file-label" id="fileLabel">starting…</div>
    <div class="live" id="liveLabel">watching FS</div>
  </header>
  <div class="layout">
    <aside class="rail" id="rail" aria-label="Structure">
      <div class="pane-title">Structure</div>
      <div class="diag">Waiting for workflow data…</div>
    </aside>
    <section class="graph-pane" aria-label="Graph">
      <div class="pane-title">Graph</div>
      <div id="graph" class="graph" tabindex="0"><pre class="graph-fallback">Loading graph…</pre></div>
      <div id="graphError" class="error-banner hidden" role="alert"></div>
    </section>
    <section class="prompt-pane" aria-label="Step prompt">
      <div class="prompt-header">
        <div>
          <div class="pane-title" id="promptTitle">Step</div>
          <div class="path" id="promptPath"></div>
        </div>
        <div class="status" id="saveStatus" data-status="idle">idle</div>
      </div>
      <div id="conflictBanner" class="conflict-banner hidden" role="alert">
        <span>Disk changed while editing. Keep yours or load disk?</span>
        <div class="conflict-actions">
          <button type="button" id="keepMine">Keep yours</button>
          <button type="button" id="loadDisk">Load disk</button>
        </div>
      </div>
      <div id="promptError" class="error-banner hidden" role="alert"></div>
      <textarea id="promptEditor" spellcheck="false" aria-label="Prompt markdown" disabled></textarea>
      <div class="footer" id="promptFooter">Select a bound node to edit its prompt.</div>
    </section>
  </div>
  <script nonce="${n}">window.__WORKFLOW_STUDIO_MERMAID_URI__ = ${JSON.stringify(String(mermaidUri))};</script>
  <script nonce="${n}">${script}</script>
</body>
</html>`;
}
