import { spawn } from "child_process";
import * as fs from "fs";
import { hookPythonBin } from "./installHooks";

export type PythonExecFailure = {
  ok: false;
  error: string;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export type PythonExecSuccess = {
  ok: true;
  stdout: string;
  stderr: string;
};

export type PythonExecResult = PythonExecSuccess | PythonExecFailure;

export function execPythonScript(
  scriptPath: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
    maxBuffer?: number;
    timeoutMs: number;
  }
): Promise<PythonExecResult> {
  if (!fs.existsSync(scriptPath)) {
    return Promise.resolve({
      ok: false,
      error: `Script not found: ${scriptPath}`,
      timedOut: false,
      stdout: "",
      stderr: "",
    });
  }
  const py = hookPythonBin();
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;

  return new Promise((resolve) => {
    const child = spawn(py, [scriptPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: PythonExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    const append = (
      chunk: Buffer,
      target: "stdout" | "stderr"
    ): boolean => {
      const next =
        (target === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (next.length > maxBuffer) {
        finish({
          ok: false,
          error: `Python output exceeded ${maxBuffer} bytes`,
          timedOut: false,
          stdout,
          stderr,
        });
        child.kill("SIGTERM");
        return false;
      }
      if (target === "stdout") {
        stdout = next;
      } else {
        stderr = next;
      }
      return true;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      append(chunk, "stdout");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(chunk, "stderr");
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        error: err.message,
        timedOut: false,
        stdout,
        stderr,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (timedOut || signal === "SIGTERM") {
        finish({
          ok: false,
          error: `Python timed out after ${options.timeoutMs}ms`,
          timedOut: true,
          stdout,
          stderr,
        });
        return;
      }
      if (code !== 0) {
        finish({
          ok: false,
          error: `Python exited with code ${code ?? "unknown"}`,
          timedOut: false,
          stdout,
          stderr,
        });
        return;
      }
      finish({ ok: true, stdout, stderr });
    });

    if (options.input) {
      child.stdin.write(options.input, "utf8");
    }
    child.stdin.end();
  });
}
