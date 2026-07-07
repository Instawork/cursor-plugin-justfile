import * as vscode from "vscode";

const CHANNEL_NAME = "Token Telemetry";

let channel: vscode.OutputChannel | undefined;

export function getTelemetryOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  }
  return channel;
}

export function disposeTelemetryOutputChannel(): void {
  channel?.dispose();
  channel = undefined;
}

function stamp(): string {
  return new Date().toISOString();
}

export function logTelemetryInfo(message: string): void {
  getTelemetryOutputChannel().appendLine(`[${stamp()}] ${message}`);
}

export function logTelemetryError(message: string, detail?: string): void {
  const ch = getTelemetryOutputChannel();
  ch.appendLine(`[${stamp()}] ERROR: ${message}`);
  if (detail?.trim()) {
    for (const line of detail.trim().split(/\r?\n/)) {
      ch.appendLine(`  ${line}`);
    }
  }
}

export function logTelemetryWarn(message: string): void {
  getTelemetryOutputChannel().appendLine(`[${stamp()}] WARN: ${message}`);
}
