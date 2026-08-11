import * as vscode from "vscode";

const CHANNEL_NAME = "Workflow Studio";

let channel: vscode.OutputChannel | undefined;

export function getLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  }
  return channel;
}

export function logInfo(message: string): void {
  getLog().appendLine(`[info] ${message}`);
}

export function logWarn(message: string): void {
  getLog().appendLine(`[warn] ${message}`);
}

export function logError(message: string, err?: unknown): void {
  const detail = formatError(err);
  getLog().appendLine(`[error] ${message}${detail ? `\n${detail}` : ""}`);
}

export function formatError(err: unknown): string {
  if (err === undefined || err === null) {
    return "";
  }
  if (err instanceof Error) {
    return err.stack || `${err.name}: ${err.message}`;
  }
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    return String(err);
  }
}

export function showLog(): void {
  getLog().show(true);
}
