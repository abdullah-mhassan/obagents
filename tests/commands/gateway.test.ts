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
import { __resetCodexSpawn } from "../../src/linker/codex-cli.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

function spawnExited(code: number): EventEmitter {
  const child = new EventEmitter();
  // Advertise `--scope` on the probe's help read so the codex scope probe
  // reports supported and registration carries the user-scope entries these
  // tests assert (mirrors a CLI that supports --scope).
  (child as any).stdout = {
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from("--scope <scope>  the scope to register the server under\n");
    },
  };
  (child as any).stderr = null;
  queueMicrotask(() => child.emit("exit", code));
  return <EventEmitter & { stdout: unknown }>child;
}

describe("obagents gateway commands & global registration", () => {
  let memFS: MemoryFileSystem;

  beforeEach(async () => {
      memFS = useMemoryFileSystem();
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

  it("installGateway ensures user-level MCP entries across global-capable tools", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);

    const { installed, errors } = await installGateway();
    expect(errors).toHaveLength(0);
    expect(installed).toContain("cursor");
    expect(installed).toContain("copilot");
    expect(installed).toContain("claude-code");
    expect(installed).toContain("opencode");
    expect(installed).toContain("antigravity");
    expect(installed).toContain("codex");

    // Non-core/legacy global tools are no longer managed by the gateway.
    expect(installed).not.toContain("windsurf");
    expect(installed).not.toContain("roo");
    expect(installed).not.toContain("continue");

    // Verify file contents for cursor, claude-code, etc.
    const cursorMcp = JSON.parse(await fs.readFile(pathResolver.getCursorMcpPath(), "utf8"));
    expect(cursorMcp.mcpServers.obagents).toEqual({ command: "obagents", args: ["serve"] });

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

    expect(status).toHaveLength(7);
    const cursorStatus = status.find((s) => s.key === "cursor");
    expect(cursorStatus?.status).toBe("registered");
    expect(cursorStatus?.global).toBe(true);

    // Non-core/legacy tools (e.g. kilo) do NOT appear in the core gateway status list.
    expect(status.find((s) => s.key === "kilo")).toBeUndefined();
  });

  it("linkAgent auto-ensures user-level MCP registration for global tools and project config for project-scoped core targets", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);
    await createAgent("dev");

    const projectDir = "/virtual/project";
    await vaultSyncEngine.linkAgent("dev", {
      targets: ["cursor", "generic"],
      projectDir,
    });

    // Global tool (cursor) wrote to home dir
    const cursorMcp = JSON.parse(await fs.readFile(pathResolver.getCursorMcpPath(), "utf8"));
    expect(cursorMcp.mcpServers.obagents).toBeDefined();

    // Project-scoped core target (generic) wrote to project dir (AGENT.md)
    const agentMd = await fs.readFile(`${projectDir}/AGENT.md`, "utf8");
    expect(agentMd).toContain("obagents:start");

    // Unlinking dev removes the generic AGENT.md (last agent), but retains cursor global MCP
    await vaultSyncEngine.unlinkAgent("dev", {
      targets: ["cursor", "generic"],
      projectDir,
    });

    const cursorMcpAfter = JSON.parse(await fs.readFile(pathResolver.getCursorMcpPath(), "utf8"));
    expect(cursorMcpAfter.mcpServers.obagents).toBeDefined();

    await expect(fs.readFile(`${projectDir}/AGENT.md`, "utf8")).rejects.toThrow();
  });

  it("linking multiple agents to a project produces at most one obagents file per tool", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);
    await createAgent("agent1");
    await createAgent("agent2");

    const projectDir = "/virtual/project";
    await vaultSyncEngine.linkAgent("agent1", { targets: ["generic"], projectDir });
    await vaultSyncEngine.linkAgent("agent2", { targets: ["generic"], projectDir });

    // Both agents share the generic adapter's single AGENT.md roster.
    const md = await fs.readFile(`${projectDir}/AGENT.md`, "utf8");
    expect(md).toContain("@agent1");
    expect(md).toContain("@agent2");

    // Unlink agent1 -> agent2 still linked to generic -> AGENT.md roster remains
    await vaultSyncEngine.unlinkAgent("agent1", { targets: ["generic"], projectDir });
    const mdMid = await fs.readFile(`${projectDir}/AGENT.md`, "utf8");
    expect(mdMid).toContain("@agent2");
    expect(mdMid).not.toContain("@agent1");

    // Unlink agent2 -> no linked agents left -> AGENT.md is removed
    await vaultSyncEngine.unlinkAgent("agent2", { targets: ["generic"], projectDir });
    await expect(fs.readFile(`${projectDir}/AGENT.md`, "utf8")).rejects.toThrow();
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
