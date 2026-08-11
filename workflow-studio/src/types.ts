import type { PromptBinding } from "./directives";

export type SaveStatus = "idle" | "editing" | "saving" | "saved" | "conflict";

export interface StructureEntry {
  kind: "controller" | "file" | "step" | "unbound";
  label: string;
  nodeId?: string;
  relativePath?: string;
  /** Groups member steps under their owning prompt file in the rail. */
  fileKey?: string;
  bound: boolean;
}

export interface HostInitPayload {
  type: "init";
  fileName: string;
  mermaidSource: string;
  bindings: PromptBinding[];
  structure: StructureEntry[];
  diagnostics: string[];
  selectedNodeId: string | null;
}

export interface HostPromptLoadedPayload {
  type: "promptLoaded";
  nodeId: string;
  relativePath: string;
  content: string;
  saveStatus: SaveStatus;
}

export interface HostPromptErrorPayload {
  type: "promptError";
  nodeId: string | null;
  message: string;
  recovery: string;
}

export interface HostSaveStatusPayload {
  type: "saveStatus";
  status: SaveStatus;
}

export interface HostConflictPayload {
  type: "conflict";
  nodeId: string;
  relativePath: string;
  diskContent: string;
}

export interface HostGraphStatusPayload {
  type: "graphStatus";
  dirty: boolean;
}

export type HostCommandName =
  | "bindSelectedNode"
  | "nextUnbound"
  | "focusRail"
  | "focusGraph"
  | "focusPrompt";

export interface HostCommandPayload {
  type: "command";
  command: HostCommandName;
}

export type HostToWebview =
  | HostInitPayload
  | HostPromptLoadedPayload
  | HostPromptErrorPayload
  | HostSaveStatusPayload
  | HostConflictPayload
  | HostGraphStatusPayload
  | HostCommandPayload;

export interface WebviewReadyMessage {
  type: "ready";
}

export interface WebviewSelectNodeMessage {
  type: "selectNode";
  nodeId: string;
}

export interface WebviewPromptEditMessage {
  type: "promptEdit";
  content: string;
}

export interface WebviewConflictResolveMessage {
  type: "conflictResolve";
  choice: "keep" | "load";
}

export interface WebviewForceFlushMessage {
  type: "forceFlush";
}

export interface WebviewBindPromptMessage {
  type: "bindPrompt";
  nodeId: string;
}

export interface WebviewLinkPromptMessage {
  type: "linkPrompt";
  nodeId: string;
}

export interface WebviewInsertStarterMessage {
  type: "insertStarter";
}

export interface WebviewOpenMmdAsTextMessage {
  type: "openMmdAsText";
}

export interface WebviewOpenPromptInEditorMessage {
  type: "openPromptInEditor";
}

export interface WebviewRevealPromptMessage {
  type: "revealPrompt";
}

export interface WebviewPreviewPromptMessage {
  type: "previewPrompt";
}

export interface WebviewRetryGraphMessage {
  type: "retryGraph";
}

export interface WebviewLogMessage {
  type: "webviewLog";
  level: "info" | "warn" | "error";
  message: string;
}

export type WebviewToHost =
  | WebviewReadyMessage
  | WebviewSelectNodeMessage
  | WebviewPromptEditMessage
  | WebviewConflictResolveMessage
  | WebviewForceFlushMessage
  | WebviewBindPromptMessage
  | WebviewLinkPromptMessage
  | WebviewInsertStarterMessage
  | WebviewOpenMmdAsTextMessage
  | WebviewOpenPromptInEditorMessage
  | WebviewRevealPromptMessage
  | WebviewPreviewPromptMessage
  | WebviewRetryGraphMessage
  | WebviewLogMessage;
