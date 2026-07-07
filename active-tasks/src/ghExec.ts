import { spawn } from "child_process";

export const DEFAULT_GH_TIMEOUT_MS = 25_000;

function ghTimeoutMs(): number {
  const raw = process.env.ACTIVE_TASKS_GH_TIMEOUT_MS;
  if (!raw?.trim()) {
    return DEFAULT_GH_TIMEOUT_MS;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GH_TIMEOUT_MS;
}

export function isGhTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message === "gh timed out";
}

/** Run `gh` with stdout capture and a hard timeout (SIGTERM). */
export function runGh(
  args: string[],
  timeoutMs = ghTimeoutMs()
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("gh timed out"));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `gh exited ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function withTimeout<T>(
  label: string,
  ms: number,
  fn: () => Promise<T>
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function cloudApiTimeoutMs(): number {
  const raw = process.env.ACTIVE_TASKS_CLOUD_TIMEOUT_MS;
  if (!raw?.trim()) {
    return 30_000;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}
