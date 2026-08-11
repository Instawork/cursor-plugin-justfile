import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  HOST_TO_WEBVIEW_TYPES,
  WEBVIEW_TO_HOST_TYPES,
  isHostToWebview,
  isWebviewToHost,
  parseWebviewToHost,
  parseHostToWebview,
} = require("../out/messages.js");

test("frozen type lists are non-empty and unique", () => {
  assert.ok(HOST_TO_WEBVIEW_TYPES.length >= 6);
  assert.ok(WEBVIEW_TO_HOST_TYPES.length >= 10);
  assert.equal(new Set(HOST_TO_WEBVIEW_TYPES).size, HOST_TO_WEBVIEW_TYPES.length);
  assert.equal(new Set(WEBVIEW_TO_HOST_TYPES).size, WEBVIEW_TO_HOST_TYPES.length);
});

test("accepts minimal valid HostToWebview payloads", () => {
  assert.equal(
    isHostToWebview({
      type: "init",
      fileName: "a.mmd",
      mermaidSource: "flowchart TD",
      bindings: [],
      structure: [],
      diagnostics: [],
      selectedNodeId: null,
    }),
    true,
  );
  assert.equal(
    isHostToWebview({
      type: "promptLoaded",
      nodeId: "A",
      relativePath: "steps/A.md",
      content: "#",
      saveStatus: "saved",
    }),
    true,
  );
  assert.equal(
    isHostToWebview({ type: "promptError", nodeId: "A", message: "m", recovery: "r" }),
    true,
  );
  assert.equal(isHostToWebview({ type: "saveStatus", status: "editing" }), true);
  assert.equal(
    isHostToWebview({ type: "conflict", nodeId: "A", relativePath: "a.md", diskContent: "x" }),
    true,
  );
  assert.equal(isHostToWebview({ type: "graphStatus", dirty: true }), true);
  assert.equal(isHostToWebview({ type: "command", command: "focusRail" }), true);
});

test("accepts minimal valid WebviewToHost payloads", () => {
  const samples = [
    { type: "ready" },
    { type: "selectNode", nodeId: "A" },
    { type: "promptEdit", content: "hi" },
    { type: "conflictResolve", choice: "keep" },
    { type: "forceFlush" },
    { type: "bindPrompt", nodeId: "A" },
    { type: "linkPrompt", nodeId: "A" },
    { type: "insertStarter" },
    { type: "openMmdAsText" },
    { type: "openPromptInEditor" },
    { type: "revealPrompt" },
    { type: "previewPrompt" },
    { type: "retryGraph" },
    { type: "webviewLog", level: "error", message: "boom" },
  ];
  for (const sample of samples) {
    assert.equal(isWebviewToHost(sample), true, sample.type);
    assert.equal(parseWebviewToHost(sample)?.type, sample.type);
  }
});

test("rejects unknown types and malformed payloads", () => {
  assert.equal(isHostToWebview({ type: "nope" }), false);
  assert.equal(isWebviewToHost({ type: "nope" }), false);
  assert.equal(isWebviewToHost({ type: "selectNode" }), false);
  assert.equal(isWebviewToHost({ type: "conflictResolve", choice: "maybe" }), false);
  assert.equal(isWebviewToHost({ type: "webviewLog", level: "trace", message: "x" }), false);
  assert.equal(isWebviewToHost({ type: "webviewLog", level: "info" }), false);
  assert.equal(isHostToWebview({ type: "graphStatus", dirty: "yes" }), false);
  assert.equal(parseHostToWebview({ type: "nope" }), undefined);
});

test("type lists include bind and graphStatus", () => {
  assert.ok(WEBVIEW_TO_HOST_TYPES.includes("bindPrompt"));
  assert.ok(WEBVIEW_TO_HOST_TYPES.includes("linkPrompt"));
  assert.ok(WEBVIEW_TO_HOST_TYPES.includes("insertStarter"));
  assert.ok(HOST_TO_WEBVIEW_TYPES.includes("graphStatus"));
  assert.ok(HOST_TO_WEBVIEW_TYPES.includes("command"));
});
