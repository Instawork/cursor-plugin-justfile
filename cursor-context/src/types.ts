export type CatalogSource = "workspace" | "user";

export type CatalogKind =
  | "rule"
  | "command"
  | "skill"
  | "hook"
  | "hookManifest"
  | "mcp"
  | "agents"
  /** Markdown prompts under `.cursor/agents` (nested dirs supported). */
  | "cursorAgents"
  | "legacy";

export type CatalogItem = {
  id: string;
  kind: CatalogKind;
  label: string;
  fsPath: string;
  workspaceRelative?: string;
  source: CatalogSource;
  /** Secondary line (path tail, MCP summary, etc.) */
  detail?: string;
  /** Present when serialized to the webview — whether inline title rename is supported. */
  renameable?: boolean;
};

export type CatalogPayload = {
  type: "catalog";
  items: CatalogItem[];
  error?: string;
  homeCursor: string;
};
