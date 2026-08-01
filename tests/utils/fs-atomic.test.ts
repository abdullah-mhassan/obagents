import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fs, useNodeFileSystem } from "../../src/utils/fs.js";

describe("NodeFileSystem atomic writeFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    useNodeFileSystem();
    tmpDir = mkdtempSync(join(tmpdir(), "obagents-fs-atomic-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes content atomically and leaves no temporary files", async () => {
    const filePath = join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "hello world", "utf8");

    const content = readFileSync(filePath, "utf8");
    expect(content).toBe("hello world");

    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["test.txt"]);
  });

  it("preserves overwrite semantics on existing target file", async () => {
    const filePath = join(tmpDir, "config.json");
    writeFileSync(filePath, '{"v": 1}', "utf8");

    await fs.writeFile(filePath, '{"v": 2}', "utf8");

    const content = readFileSync(filePath, "utf8");
    expect(content).toBe('{"v": 2}');

    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["config.json"]);
  });

  it("cleans up temporary file and leaves original file untouched on rename failure", async () => {
    const filePath = join(tmpDir, "target.txt");
    writeFileSync(filePath, "original content", "utf8");

    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await expect(fs.writeFile(filePath, "new content", "utf8")).rejects.toThrow("permission denied");

    // Original file content remains unchanged
    expect(readFileSync(filePath, "utf8")).toBe("original content");

    // No leftover .tmp files
    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["target.txt"]);
    expect(renameSpy).toHaveBeenCalled();
  });
});
