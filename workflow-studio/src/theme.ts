/** Canonical Workflow Studio dark palette for SVG export and CSS fallbacks. */
export const WORKFLOW_STUDIO_THEME = {
  bg: "#0f1216",
  fg: "#d7dde6",
  surface: "#171b22",
  border: "#2a313d",
  line: "#2a313d",
  accent: "#4cc2ff",
  muted: "#8b95a7",
  transparent: true,
} as const;

export type WorkflowStudioTheme = typeof WORKFLOW_STUDIO_THEME;
