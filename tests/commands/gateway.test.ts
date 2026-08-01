import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { useMemoryFileSystem, useNodeFileSystem, MemoryFileSystem, fs } from "../../src/utils/fs.js";
import { pathResolver, overrideVaultRoot } from "../../src/utils/paths.js";
import { installGateway, uninstallGateway, getGatewayStatus } from "../../src/linker/gateway.js";
import { vaultSyncEngine } from "../../src/vault/sync.js";
import { createAgent } from "../../src/vault/agent.js";
import { diffProject } from "../../src/linker/diff.js";
import { createProgram } from "../../src/cli.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

function spawnExited(code: number): EventEmitter {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", code));
  return child;
}

describe("obagents gateway commands & global registration", () => {
  let memFS: MemoryFileSystem;

  beforeEach(async () => {
    memFS = useMemoryFileSystem();
    overrideVaultRoot("/virtual/vault");
    pathResolver.setHomeDir("/virtual/home");
    spawnMock.mockReset();
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
    pathResolver.reset();
    vi.restoreAllMocks();
  });

  it("installGateway ensures user-level MCP entries across global-capable tools", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);

    const { installed, errors } = await installGateway();
    expect(errors).toHaveLength(0);
    expect(installed).toContain("cursor");
    expect(installed).toContain("windsurf");
    expect(installed).toContain("roo");
    expect(installed).toContain("continue");
    expect(installed).toContain("copilot");
    expect(installed).toContain("claude-code");
    expect(installed).toContain("opencode");
    expect(installed).toContain("antigravity");
    expect(installed).toContain("codex");

    // Verify file contents for cursor, continue, etc.
    const cursorMcp = JSON.parse(await fs.readFile(pathResolver.getCursorMcpPath(), "utf8"));
    expect(cursorMcp.mcpServers.obagents).toEqual({ command: "obagents", args: ["serve"] });

    const continueMcp = JSON.parse(await fs.readFile(pathResolver.getContinueMcpPath(), "utf8"));
    expect(continueMcp.mcpServers.find((s: any) => s.name === "obagents")).toEqual({
      name: "obagents",
      type: "stdio",
      command: "obagents",
      args: ["serve"],
    });

    const claudeMcp = JSON.parse(await fs.readFile(pathResolver.getClaudeCodeMcpPath(), "utf8"));
    expect(claudeMcp.mcpServers.obagents).toEqual({ command: "obagents", args: ["serve"] });

    // Verify Codex spawn call
    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["mcp", "add", "obagents", "--scope", "user", "--", "obagents", "serve"],
      expect.anything(),
    );
  });

  it("uninstallGateway removes user-level MCP entries across global-capable tools", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);

    await installGateway();
    const { uninstalled, errors } = await uninstallGateway();
    expect(errors).toHaveLength(0);
    expect(uninstalled).toContain("cursor");
    expect(uninstalled).toContain("codex");

    const cursorMcp = JSON.parse(await fs.readFile(pathResolver.getCursorMcpPath(), "utf8"));
    expect(cursorMcp.mcpServers.obagents).toBeUndefined();

    expect(spawnMock).toHaveBeenLastCalledWith(
      "codex",
      ["mcp", "remove", "obagents", "--scope", "user"],
      expect.anything(),
    );
  });

  it("getGatewayStatus lists each supported tool with registered/missing state", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);

    await installGateway();
    const status = await getGatewayStatus("/virtual/project");

    expect(status).toHaveLength(17);
    const cursorStatus = status.find((s) => s.key === "cursor");
    expect(cursorStatus?.status).toBe("registered");
    expect(cursorStatus?.global).toBe(true);

    const kiloStatus = status.find((s) => s.key === "kilo");
    expect(kiloStatus?.status).toBe("missing");
    expect(kiloStatus?.global).toBe(false);
  });

  it("linkAgent auto-ensures user-level MCP registration for global tools and project config for project-only tools", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);
    await createAgent("dev");

    const projectDir = "/virtual/project";
    await vaultSyncEngine.linkAgent("dev", {
      targets: ["cursor", "kilo"],
      projectDir,
    });

    // Global tool (cursor) wrote to home dir
    const cursorMcp = JSON.parse(await fs.readFile(pathResolver.getCursorMcpPath(), "utf8"));
    expect(cursorMcp.mcpServers.obagents).toBeDefined();

    // Project-only tool (kilo) wrote to project dir
    const kiloMcp = JSON.parse(await fs.readFile(`${projectDir}/kilo.json`, "utf8"));
    expect(kiloMcp.mcpServers.obagents).toBeDefined();

    // Unlinking dev removes kilo MCP (last agent), but retains cursor global MCP
    await vaultSyncEngine.unlinkAgent("dev", {
      targets: ["cursor", "kilo"],
      projectDir,
    });

    const cursorMcpAfter = JSON.parse(await fs.readFile(pathResolver.getCursorMcpPath(), "utf8"));
    expect(cursorMcpAfter.mcpServers.obagents).toBeDefined();

    const kiloMcpAfter = JSON.parse(await fs.readFile(`${projectDir}/kilo.json`, "utf8"));
    expect(kiloMcpAfter.mcpServers.obagents).toBeUndefined();
  });

  it("linking multiple agents to a project produces at most one obagents entry per tool", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);
    await createAgent("agent1");
    await createAgent("agent2");

    const projectDir = "/virtual/project";
    await vaultSyncEngine.linkAgent("agent1", { targets: ["kilo"], projectDir });
    await vaultSyncEngine.linkAgent("agent2", { targets: ["kilo"], projectDir });

    const kiloMcp = JSON.parse(await fs.readFile(`${projectDir}/kilo.json`, "utf8"));
    expect(Object.keys(kiloMcp.mcpServers)).toEqual(["obagents"]);

    // Unlink agent1 -> agent2 still linked to kilo -> obagents MCP entry remains
    await vaultSyncEngine.unlinkAgent("agent1", { targets: ["kilo"], projectDir });
    const kiloMcpMid = JSON.parse(await fs.readFile(`${projectDir}/kilo.json`, "utf8"));
    expect(kiloMcpMid.mcpServers.obagents).toBeDefined();

    // Unlink agent2 -> no linked agents left -> obagents MCP entry removed
    await vaultSyncEngine.unlinkAgent("agent2", { targets: ["kilo"], projectDir });
    const kiloMcpFinal = JSON.parse(await fs.readFile(`${projectDir}/kilo.json`, "utf8"));
    expect(kiloMcpFinal.mcpServers.obagents).toBeUndefined();
  });

  it("CLI obagents gateway subcommands execute cleanly", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);
    const program = createProgram();

    await program.parseAsync(["node", "obagents", "gateway", "install"]);
    await program.parseAsync(["node", "obagents", "gateway", "status"]);
    await program.parseAsync(["node", "obagents", "gateway", "uninstall"]);

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["mcp", "add", "obagents", "--scope", "user", "--", expect.any(String), "serve"],
      expect.anything(),
    );
  });
});
