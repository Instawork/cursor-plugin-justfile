import type { HostToWebview, WebviewToHost } from "./types";

export const HOST_TO_WEBVIEW_TYPES = [
  "init",
  "promptLoaded",
  "promptError",
  "saveStatus",
  "conflict",
  "graphStatus",
  "command",
] as const;

export const WEBVIEW_TO_HOST_TYPES = [
  "ready",
  "selectNode",
  "promptEdit",
  "conflictResolve",
  "forceFlush",
  "bindPrompt",
  "linkPrompt",
  "insertStarter",
  "openMmdAsText",
  "openPromptInEditor",
  "revealPrompt",
  "previewPrompt",
  "retryGraph",
  "webviewLog",
] as const;

export type HostToWebviewType = (typeof HOST_TO_WEBVIEW_TYPES)[number];
export type WebviewToHostType = (typeof WEBVIEW_TO_HOST_TYPES)[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasType(value: Record<string, unknown>): value is Record<string, unknown> & { type: string } {
  return typeof value.type === "string";
}

export function isHostToWebview(raw: unknown): raw is HostToWebview {
  if (!isObject(raw) || !hasType(raw)) {
    return false;
  }
  if (!(HOST_TO_WEBVIEW_TYPES as readonly string[]).includes(raw.type)) {
    return false;
  }
  switch (raw.type) {
    case "init":
      return (
        typeof raw.fileName === "string" &&
        typeof raw.mermaidSource === "string" &&
        Array.isArray(raw.bindings) &&
        Array.isArray(raw.structure) &&
        Array.isArray(raw.diagnostics)
      );
    case "promptLoaded":
      return (
        typeof raw.nodeId === "string" &&
        typeof raw.relativePath === "string" &&
        typeof raw.content === "string" &&
        typeof raw.saveStatus === "string"
      );
    case "promptError":
      return typeof raw.message === "string" && typeof raw.recovery === "string";
    case "saveStatus":
      return typeof raw.status === "string";
    case "conflict":
      return (
        typeof raw.nodeId === "string" &&
        typeof raw.relativePath === "string" &&
        typeof raw.diskContent === "string"
      );
    case "graphStatus":
      return typeof raw.dirty === "boolean";
    case "command":
      return typeof raw.command === "string";
    default:
      return false;
  }
}

export function isWebviewToHost(raw: unknown): raw is WebviewToHost {
  if (!isObject(raw) || !hasType(raw)) {
    return false;
  }
  if (!(WEBVIEW_TO_HOST_TYPES as readonly string[]).includes(raw.type)) {
    return false;
  }
  switch (raw.type) {
    case "ready":
    case "forceFlush":
    case "insertStarter":
    case "openMmdAsText":
    case "openPromptInEditor":
    case "revealPrompt":
    case "previewPrompt":
    case "retryGraph":
      return true;
    case "webviewLog":
      return (
        (raw.level === "info" || raw.level === "warn" || raw.level === "error") &&
        typeof raw.message === "string"
      );
    case "selectNode":
    case "bindPrompt":
      return typeof raw.nodeId === "string";
    case "linkPrompt":
      return typeof raw.nodeId === "string";
    case "promptEdit":
      return typeof raw.content === "string";
    case "conflictResolve":
      return raw.choice === "keep" || raw.choice === "load";
    default:
      return false;
  }
}

export function parseWebviewToHost(raw: unknown): WebviewToHost | undefined {
  return isWebviewToHost(raw) ? raw : undefined;
}

export function parseHostToWebview(raw: unknown): HostToWebview | undefined {
  return isHostToWebview(raw) ? raw : undefined;
}
