import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { useMemoryFileSystem, useNodeFileSystem } from "../../src/utils/fs.js";
import { pathResolver, overrideVaultRoot } from "../../src/utils/paths.js";
import { vaultSyncEngine } from "../../src/vault/sync.js";
import { createAgent } from "../../src/vault/agent.js";
import { installGateway } from "../../src/linker/gateway.js";
import { __resetCodexSpawn } from "../../src/linker/codex-cli.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

// Simulate a `codex` process that fails (exit 1). Its stdout does NOT
// advertise `--scope`, so the codex-cli probe reports scope as unsupported
// and registration proceeds with plain (non-scope) args — then still fails.
function spawnFailingExited(code: number): EventEmitter {
  const child = new EventEmitter();
  (child as any).stdout = {
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from("usage: codex mcp add <name> <command>...\n");
    },
  };
  (child as any).stderr = null;
  queueMicrotask(() => child.emit("exit", code));
  return <EventEmitter & { stdout: unknown }>child;
}

describe("codex MCP registration fails loudly at the link/CLI level", () => {
  beforeEach(async () => {
    useMemoryFileSystem();
    overrideVaultRoot("/virtual/vault");
    pathResolver.setHomeDir("/virtual/home");
    spawnMock.mockReset();
    __resetCodexSpawn();
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
    pathResolver.reset();
    vi.restoreAllMocks();
  });

  it("linkAgent rejects when the codex registration fails", async () => {
    spawnMock.mockImplementation(() => spawnFailingExited(1) as any);
    await createAgent("dev");

    await expect(
      vaultSyncEngine.linkAgent("dev", {
        targets: ["codex"],
        projectDir: "/virtual/p",
      }),
    ).rejects.toThrow(/Codex MCP registration failed/);
  });

  it("gateway installGateway surfaces the codex error in its errors list", async () => {
    spawnMock.mockImplementation(() => spawnFailingExited(1) as any);

    const { installed, errors } = await installGateway();

    expect(installed).not.toContain("codex");
    expect(errors.some((e) => e.toLowerCase().includes("codex"))).toBe(true);
  });
});