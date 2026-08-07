import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";

export interface IFileSystem {
  readFile(path: string, options?: any): Promise<string>;
  writeFile(path: string, data: string, options?: any): Promise<void>;
  existsSync(path: string): boolean;
  mkdir(path: string, options?: any): Promise<void>;
  rm(path: string, options?: any): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

import { randomBytes } from "node:crypto";
import { dirname, basename, join } from "node:path";

class NodeFileSystem implements IFileSystem {
  async readFile(path: string, options: any = "utf8"): Promise<string> {
    return nodeFsPromises.readFile(path, options) as unknown as Promise<string>;
  }
  async writeFile(path: string, data: string, options: any = "utf8"): Promise<void> {
    const dir = dirname(path);
    const tmpPath = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await nodeFsPromises.writeFile(tmpPath, data, options);
      await fs.rename(tmpPath, path);
    } catch (err) {
      await nodeFsPromises.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }
  existsSync(path: string): boolean {
    return nodeFs.existsSync(path);
  }
  async mkdir(path: string, options?: any): Promise<void> {
    await nodeFsPromises.mkdir(path, { recursive: true, ...options });
  }
  async rm(path: string, options?: any): Promise<void> {
    await nodeFsPromises.rm(path, { force: true, recursive: true, ...options });
  }
  async copyFile(src: string, dest: string): Promise<void> {
    await nodeFsPromises.copyFile(src, dest);
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    await nodeFsPromises.rename(oldPath, newPath);
  }
}

export class MemoryFileSystem implements IFileSystem {
  public files = new Map<string, string>();
  public dirs = new Set<string>();

  async readFile(path: string): Promise<string> {
    if (!this.files.has(path)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return this.files.get(path)!;
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
  existsSync(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path);
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async rm(path: string): Promise<void> {
    this.files.delete(path);
    this.dirs.delete(path);
  }
  async copyFile(src: string, dest: string): Promise<void> {
    const content = await this.readFile(src);
    await this.writeFile(dest, content);
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = await this.readFile(oldPath);
    await this.writeFile(newPath, content);
    await this.rm(oldPath);
  }
}

let activeFS: IFileSystem = new NodeFileSystem();

export const fs = {
  readFile: (path: string, options?: any) => activeFS.readFile(path, options),
  writeFile: (path: string, data: string, options?: any) => activeFS.writeFile(path, data, options),
  existsSync: (path: string) => activeFS.existsSync(path),
  mkdir: (path: string, options?: any) => activeFS.mkdir(path, options),
  rm: (path: string, options?: any) => activeFS.rm(path, options),
  copyFile: (src: string, dest: string) => activeFS.copyFile(src, dest),
  rename: (oldPath: string, newPath: string) => activeFS.rename(oldPath, newPath),
};

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(filePath, content, "utf8");
}

export function setFileSystem(fileSystem: IFileSystem): void {
  activeFS = fileSystem;
}

export function useMemoryFileSystem(): MemoryFileSystem {
  const memFS = new MemoryFileSystem();
  setFileSystem(memFS);
  return memFS;
}

export function useNodeFileSystem(): void {
  setFileSystem(new NodeFileSystem());
}

/**
 * True when the active file system is the in-memory one (used by unit tests).
 * A memory-backed FS has no cross-process semantics, so callers that need
 * cross-process exclusivity should skip their file-lock dance in that case.
 */
export function isMemoryFileSystem(): boolean {
  return activeFS instanceof MemoryFileSystem;
}
