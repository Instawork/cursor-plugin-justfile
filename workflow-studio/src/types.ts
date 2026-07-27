import type { PromptBinding } from "./directives";

export type SaveStatus = "idle" | "editing" | "saving" | "saved" | "conflict";

export interface StructureEntry {
  kind: "controller" | "step" | "unbound";
  label: string;
  nodeId?: string;
  relativePath?: string;
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

export type HostToWebview =
  | HostInitPayload
  | HostPromptLoadedPayload
  | HostPromptErrorPayload
  | HostSaveStatusPayload
  | HostConflictPayload;

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

export type WebviewToHost =
  | WebviewReadyMessage
  | WebviewSelectNodeMessage
  | WebviewPromptEditMessage
  | WebviewConflictResolveMessage
  | WebviewForceFlushMessage;
