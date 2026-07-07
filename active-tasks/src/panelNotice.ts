import type { ActiveTasksPayload } from "./payload";

export type PanelNoticeLevel = "error" | "warn";

export type PanelNotice = {
  level: PanelNoticeLevel;
  title: string;
  detail?: string;
  action?: "retry" | "openDb" | "sync";
};

export function formatPanelError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function noticeFromPayload(payload: ActiveTasksPayload): PanelNotice | null {
  if (payload.notice) {
    return payload.notice;
  }
  if (payload.loadError) {
    return {
      level: "error",
      title: "Database unavailable",
      detail: payload.loadError,
      action: "retry",
    };
  }
  return null;
}

export function discoveryWarnings(
  payload: ActiveTasksPayload
): PanelNotice | null {
  const d = payload.discovery;
  const parts: string[] = [];
  if (d.githubError) {
    parts.push("GitHub: " + d.githubError);
  }
  if (d.cloudError) {
    parts.push("Cloud: " + d.cloudError);
  }
  if (!parts.length) {
    return null;
  }
  return {
    level: "warn",
    title: "Scan incomplete",
    detail: parts.join(" · "),
    action: "retry",
  };
}
