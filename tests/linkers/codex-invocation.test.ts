import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createMapper } from "../../src/linker/mappers/base.js";
import { DESCRIPTORS } from "../../src/linker/mappers/declarations.js";
import { resolveBinaryCommand } from "../../src/linker/mcp.js";
import { projectVault, normalizeProjectPath } from "../../src/vault/project.js";
import { useMemoryFileSystem, useNodeFileSystem, MemoryFileSystem } from "../../src/utils/fs.js";
import { logger } from "../../src/utils/logger.js";
import type { LinkContext } from "../../src/linker/types.js";
import { __resetCodexSpawn } from "../../src/linker/codex-cli.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

const codexMapper = createMapper(DESCRIPTORS.find((d) => d.key === "codex")!);

const PROJECT = "/virtual/project with spaces & shell$(metas)";

function createFakeContext(agentName: string, projectDir: string): LinkContext {
  return {
    agentName,
    projectDir,
    targets: ["codex"],
    async getRosterContent() {
      return "roster";
    },
    async getPassiveContent() {
      return "passive";
    },
    async getAgentMcpConfig() {
      return { command: "obagents", args: ["serve", agentName] };
    },
  };
}

function spawnExited(code: number): EventEmitter {
  const child = new EventEmitter();
  // Advertise `--scope` so the codex scope probe detects support and the
  // registration call carries the user-scope args this suite asserts.
  (child as any).stdout = {
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from("--scope <scope>  the scope to register the server under\n");
    },
  };
  (child as any).stderr = null;
  queueMicrotask(() => child.emit("exit", code));
  return <EventEmitter & { stderr: unknown }>child;
}

describe("codex mapper external invocation", () => {
  let memFS: MemoryFileSystem;

  beforeEach(() => {
    memFS = useMemoryFileSystem();
    spawnMock.mockReset();
    __resetCodexSpawn();
  });

  afterEach(() => {
    useNodeFileSystem();
    vi.restoreAllMocks();
  });

  it("spawns codex mcp add with obagents user-scope registration", async () => {
    const agentName = "dev-agent";
    const context = createFakeContext(agentName, PROJECT);
    spawnMock.mockImplementation(() => spawnExited(0) as any);

    await codexMapper.apply(context);

    // The scope-probe (`codex mcp add --help`) spawns first; the registration
    // spawn follows. Only the second call carries the user-scope registration.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]).toEqual(
      expect.arrayContaining(["codex", ["mcp", "add", "--help"]]),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      [
        "mcp",
        "add",
        "obagents",
        "--scope",
        "user",
        "--",
        resolveBinaryCommand(),
        "serve",
      ],
      expect.objectContaining({ cwd: PROJECT }),
    );
  });

  it("does not spawn codex mcp remove when unlinking an agent from project", async () => {
    const agentName = "dev-agent";
    const context = createFakeContext(agentName, PROJECT);
    spawnMock.mockImplementation(() => spawnExited(0) as any);

    await codexMapper.apply(context);
    spawnMock.mockClear();
    await codexMapper.remove(context, { agentName });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("executes no external command under dry-run", async () => {
    const context = createFakeContext("dev-agent", PROJECT);

    await codexMapper.apply(context, { dryRun: true });
    await codexMapper.remove(context, { agentName: "dev-agent", dryRun: true });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("fails loudly when the codex MCP registration command fails", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warningSpy = vi.spyOn(logger, "warning").mockImplementation(() => {});
    const context = createFakeContext("dev-agent", PROJECT);
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit("error", new Error("codex not found")));
      return child as any;
    });

    await expect(codexMapper.apply(context)).rejects.toThrow(
      /Codex MCP registration failed/,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Codex MCP registration failed"),
    );
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it("treats a failing codex command as a fatal link error", async () => {
    const context = createFakeContext("dev-agent", PROJECT);
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", 1));
      return child as any;
    });

    await expect(codexMapper.apply(context)).rejects.toThrow(
      /Codex MCP registration failed/,
    );
  });
});
