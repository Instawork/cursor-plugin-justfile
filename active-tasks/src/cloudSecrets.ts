import * as vscode from "vscode";

const ACTIVE_TASKS_KEY = "activeTasks.cursorApiKey";
const TOKEN_TELEMETRY_KEY = "tokenTelemetry.cursorApiKey";

export async function getCloudApiKey(
  secrets: vscode.SecretStorage
): Promise<string | undefined> {
  const fromActive = (await secrets.get(ACTIVE_TASKS_KEY))?.trim();
  if (fromActive) {
    return fromActive;
  }
  const fromTelemetry = (await secrets.get(TOKEN_TELEMETRY_KEY))?.trim();
  if (fromTelemetry) {
    return fromTelemetry;
  }
  const fromEnv = (
    process.env.CURSOR_CLOUD_API_KEY ||
    process.env.CURSOR_API_KEY ||
    ""
  ).trim();
  return fromEnv || undefined;
}

export async function setCloudApiKey(
  secrets: vscode.SecretStorage,
  apiKey: string
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await secrets.delete(ACTIVE_TASKS_KEY);
    return;
  }
  await secrets.store(ACTIVE_TASKS_KEY, trimmed);
}

export async function clearCloudApiKey(
  secrets: vscode.SecretStorage
): Promise<void> {
  await secrets.delete(ACTIVE_TASKS_KEY);
}
