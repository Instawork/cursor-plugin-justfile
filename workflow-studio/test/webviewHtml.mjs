import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { buildWebviewHtml } = require("../out/webviewHtml.js");

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const BM_URI = "https://media.example/beautiful-mermaid.js?v=test";

function fakeWebview() {
  return { cspSource: "https://csp.example" };
}

test("buildWebviewHtml embeds the beautiful-mermaid uri it is given", () => {
  const html = buildWebviewHtml(fakeWebview(), { fsPath: extensionRoot }, BM_URI);
  assert.match(html, /__WORKFLOW_STUDIO_BM_URI__ = "https:\/\/media\.example\/beautiful-mermaid\.js\?v=test"/);
});

test("buildWebviewHtml needs only cspSource from the webview", () => {
  const html = buildWebviewHtml({ cspSource: "https://csp.example" }, { fsPath: extensionRoot }, BM_URI);
  assert.match(html, /https:\/\/csp\.example/);
});

test("buildWebviewHtml includes CSP nonce dual status bind card toolbar filter aria-live", () => {
  const html = buildWebviewHtml(fakeWebview(), { fsPath: extensionRoot }, BM_URI);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /nonce=/);
  assert.match(html, /id="graphStatusChip"/);
  assert.match(html, /id="promptStatusChip"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /id="bindCard"/);
  assert.match(html, /id="bindCreateBtn"/);
  assert.match(html, /id="zoomFit"/);
  assert.match(html, /id="zoomReset"/);
  assert.match(html, /id="zoomIn"/);
  assert.match(html, /id="zoomOut"/);
  assert.match(html, /id="railFilter"/);
  assert.match(html, /id="insertStarterBtn"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /__WS_panZoom__/);
  assert.match(html, /__WS_railModel__/);
});
