import * as vscode from "vscode";

const SECRET_KEY = "tokenTelemetry.cursorApiKey";

export async function getCloudApiKey(
  secrets: vscode.SecretStorage
): Promise<string | undefined> {
  const raw = await secrets.get(SECRET_KEY);
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export async function setCloudApiKey(
  secrets: vscode.SecretStorage,
  apiKey: string
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await secrets.delete(SECRET_KEY);
    return;
  }
  await secrets.store(SECRET_KEY, trimmed);
}

export async function clearCloudApiKey(
  secrets: vscode.SecretStorage
): Promise<void> {
  await secrets.delete(SECRET_KEY);
}

export async function hasCloudApiKey(
  secrets: vscode.SecretStorage
): Promise<boolean> {
  return (await getCloudApiKey(secrets)) !== undefined;
}
