import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { useMemoryFileSystem, useNodeFileSystem } from "../../src/utils/fs.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { createAgent } from "../../src/vault/agent.js";
import { getCoreFilePath } from "../../src/vault/project.js";
import { createEditCommand, parseEditorCommand } from "../../src/commands/edit.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

function spawnExited(code: number): EventEmitter {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", code));
  return child;
}

describe("parseEditorCommand", () => {
  it("splits flag-style $EDITOR values into binary and flags", () => {
    expect(parseEditorCommand("code -w --wait")).toEqual(["code", "-w", "--wait"]);
    expect(parseEditorCommand("nano")).toEqual(["nano"]);
  });
});

describe("edit command editor spawn", () => {
  let oldEditor: string | undefined;

  beforeEach(() => {
    useMemoryFileSystem();
    overrideVaultRoot("/virtual/vault");
    oldEditor = process.env.EDITOR;
    process.env.EDITOR = "code -w";
    spawnMock.mockReset();
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
    if (oldEditor === undefined) {
      delete process.env.EDITOR;
    } else {
      process.env.EDITOR = oldEditor;
    }
    vi.restoreAllMocks();
  });

  it("spawns the editor binary with flags and the target file as separate arguments", async () => {
    await createAgent("my-agent");
    spawnMock.mockImplementation(() => spawnExited(0) as any);

    const command = createEditCommand();
    await command.parseAsync(["my-agent", "memory", "-p", "/virtual/proj"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "code",
      ["-w", getCoreFilePath("my-agent", "MEMORY.md", "/virtual/proj")],
      { stdio: "inherit" },
    );
  });
});
