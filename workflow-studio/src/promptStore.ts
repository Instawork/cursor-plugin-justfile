import * as fs from "fs/promises";
import { MAX_PROMPT_BYTES, resolvePromptTarget } from "./pathSafety";
import type { SaveStatus } from "./types";

export type PromptLoadOk = {
  ok: true;
  absolutePath: string;
  relativePath: string;
  content: string;
  exists: boolean;
};

export type PromptLoadErr = {
  ok: false;
  message: string;
  recovery: string;
};

export type PromptLoadResult = PromptLoadOk | PromptLoadErr;

export interface PromptWatcher {
  dispose(): void;
  onDidChange?(listener: () => void): { dispose(): void };
  onDidCreate?(listener: () => void): { dispose(): void };
}

export type WatcherFactory = (targetPath: string) => PromptWatcher;

const noopWatcherFactory: WatcherFactory = () => ({ dispose() {} });

export class PromptSession {
  private absolutePath: string | undefined;
  private relativePath: string | undefined;
  private nodeId: string | undefined;
  private buffer = "";
  private diskContent = "";
  private dirty = false;
  private saveStatus: SaveStatus = "idle";
  private debounce: NodeJS.Timeout | undefined;
  private watcher: PromptWatcher | undefined;
  private writing = false;
  private delayMs: number;
  private readonly createWatcher: WatcherFactory;

  constructor(
    private readonly onStatus: (status: SaveStatus) => void,
    private readonly onConflict: (payload: {
      nodeId: string;
      relativePath: string;
      diskContent: string;
    }) => void,
    private readonly onExternalReload: (content: string) => void,
    delayMs = 400,
    createWatcher: WatcherFactory = noopWatcherFactory,
  ) {
    this.delayMs = delayMs;
    this.createWatcher = createWatcher;
  }

  getStatus(): SaveStatus {
    return this.saveStatus;
  }

  getNodeId(): string | undefined {
    return this.nodeId;
  }

  getAbsolutePath(): string | undefined {
    return this.absolutePath;
  }

  getRelativePath(): string | undefined {
    return this.relativePath;
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  async flush(): Promise<void> {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    if (!this.dirty || !this.absolutePath) {
      return;
    }
    await this.writeBuffer();
  }

  async dispose(): Promise<void> {
    await this.flush();
    this.clearWatcher();
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
  }

  async clearEditor(): Promise<void> {
    await this.flush();
    this.clearWatcher();
    this.absolutePath = undefined;
    this.relativePath = undefined;
    this.nodeId = undefined;
    this.buffer = "";
    this.diskContent = "";
    this.dirty = false;
    this.setStatus("idle");
  }

  async load(
    diagramPath: string,
    nodeId: string,
    relativePath: string,
    workspaceRoots: string[],
  ): Promise<PromptLoadResult> {
    await this.flush();
    this.clearWatcher();

    const resolved = await resolvePromptTarget(diagramPath, relativePath, workspaceRoots);
    if (!resolved.safe || !resolved.targetPath) {
      this.nodeId = nodeId;
      this.relativePath = relativePath;
      this.absolutePath = undefined;
      this.buffer = "";
      this.diskContent = "";
      this.dirty = false;
      this.setStatus("idle");
      return {
        ok: false,
        message: resolved.reason ?? "Prompt path is not safe to open.",
        recovery: "Fix the %% @prompt path so it stays inside the workspace and avoids secret files, then select the node again.",
      };
    }

    if (!resolved.exists) {
      this.nodeId = nodeId;
      this.relativePath = relativePath;
      this.absolutePath = resolved.targetPath;
      this.buffer = "";
      this.diskContent = "";
      this.dirty = false;
      this.setStatus("idle");
      return {
        ok: false,
        message: `Missing prompt file for ${nodeId}: ${relativePath}`,
        recovery: "Create the markdown file (or fix the directive path), then select the node again.",
      };
    }

    try {
      const stat = await fs.stat(resolved.targetPath);
      if (stat.size > MAX_PROMPT_BYTES) {
        return {
          ok: false,
          message: `Prompt file exceeds the ${MAX_PROMPT_BYTES} byte limit.`,
          recovery: "Split or trim the step file, then select the node again.",
        };
      }
      const content = await fs.readFile(resolved.targetPath, "utf8");
      this.nodeId = nodeId;
      this.relativePath = relativePath;
      this.absolutePath = resolved.targetPath;
      this.buffer = content;
      this.diskContent = content;
      this.dirty = false;
      this.setStatus("saved");
      this.watch(resolved.targetPath);
      return {
        ok: true,
        absolutePath: resolved.targetPath,
        relativePath,
        content,
        exists: true,
      };
    } catch {
      return {
        ok: false,
        message: `Could not read prompt file for ${nodeId}.`,
        recovery: "Check file permissions, then select the node again.",
      };
    }
  }

  noteEdit(content: string): void {
    if (!this.absolutePath || this.saveStatus === "conflict") {
      return;
    }
    this.buffer = content;
    this.dirty = content !== this.diskContent;
    this.setStatus(this.dirty ? "editing" : "saved");
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      void this.writeBuffer();
    }, this.delayMs);
  }

  async resolveConflict(choice: "keep" | "load"): Promise<string | undefined> {
    if (this.saveStatus !== "conflict" || !this.absolutePath) {
      return undefined;
    }
    if (choice === "keep") {
      this.dirty = true;
      await this.writeBuffer();
      return this.buffer;
    }
    this.buffer = this.diskContent;
    this.dirty = false;
    this.setStatus("saved");
    return this.buffer;
  }

  /** Test/helper: force conflict state with given disk content. */
  forceConflictForTest(diskContent: string): void {
    this.diskContent = diskContent;
    this.dirty = true;
    this.setStatus("conflict");
    this.onConflict({
      nodeId: this.nodeId ?? "",
      relativePath: this.relativePath ?? "",
      diskContent,
    });
  }

  private async writeBuffer(): Promise<void> {
    if (!this.absolutePath || !this.dirty || this.writing) {
      return;
    }
    this.writing = true;
    this.setStatus("saving");
    try {
      const bytes = Buffer.byteLength(this.buffer, "utf8");
      if (bytes > MAX_PROMPT_BYTES) {
        this.setStatus("editing");
        return;
      }
      await fs.writeFile(this.absolutePath, this.buffer, "utf8");
      this.diskContent = this.buffer;
      this.dirty = false;
      this.setStatus("saved");
    } catch {
      this.setStatus("editing");
    } finally {
      this.writing = false;
    }
  }

  private watch(targetPath: string): void {
    this.clearWatcher();
    const watcher = this.createWatcher(targetPath);
    this.watcher = watcher;
    const onChange = async () => {
      if (this.writing || !this.absolutePath) {
        return;
      }
      try {
        const disk = await fs.readFile(this.absolutePath, "utf8");
        if (disk === this.diskContent && disk === this.buffer) {
          return;
        }
        this.diskContent = disk;
        if (!this.dirty) {
          this.buffer = disk;
          this.setStatus("saved");
          this.onExternalReload(disk);
          return;
        }
        if (disk !== this.buffer) {
          this.setStatus("conflict");
          this.onConflict({
            nodeId: this.nodeId ?? "",
            relativePath: this.relativePath ?? "",
            diskContent: disk,
          });
        }
      } catch {
        // Missing after delete: surface on next select.
      }
    };
    watcher.onDidChange?.(() => void onChange());
    watcher.onDidCreate?.(() => void onChange());
  }

  private clearWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private setStatus(status: SaveStatus): void {
    this.saveStatus = status;
    this.onStatus(status);
  }
}
