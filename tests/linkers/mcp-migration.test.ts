import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { manageMcpConfig, parseJsonc } from "../../src/linker/mcp.js";
import { diffProject, fixDrift } from "../../src/linker/diff.js";
import { useMemoryFileSystem, useNodeFileSystem, fs } from "../../src/utils/fs.js";
import { createAgent } from "../../src/vault/agent.js";
import { overrideVaultRoot, pathResolver } from "../../src/utils/paths.js";
import { vaultSyncEngine } from "../../src/vault/sync.js";
import { installGateway } from "../../src/linker/gateway.js";
import { logger } from "../../src/utils/logger.js";

describe("MCP Auto-Migration of Stale Per-Agent Entries", () => {
  const PROJECT = "/virtual/project";

  beforeEach(async () => {
    useMemoryFileSystem();
    overrideVaultRoot("/virtual/vault");
    pathResolver.setHomeDir("/virtual/home");
    await createAgent("swe");
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
    pathResolver.reset();
    vi.restoreAllMocks();
  });

  it("migrates mcpServers format (Cursor/Windsurf/Roo): strips obagents-*, preserves myagent-* & custom, preserves comments, logs warning", async () => {
    const configPath = "/virtual/project/.cursor/mcp.json";
    const initialContent = `{
  // Main Cursor MCP config
  "mcpServers": {
    "obagents-swe-123456": {
      "command": "obagents",
      "args": ["serve"]
    },
    // Legacy myagent entry
    "myagent-legacy": {
      "command": "myagent",
      "args": []
    },
    "custom-tool": {
      "command": "custom-mcp"
    }
  }
}`;
    await fs.mkdir("/virtual/project/.cursor", { recursive: true });
    await fs.writeFile(configPath, initialContent, "utf8");

    const warningSpy = vi.spyOn(logger, "warning");

    await manageMcpConfig({
      agentName: "swe",
      projectDir: PROJECT,
      configPath,
      format: "mcpServers",
      action: "link",
    });

    const updatedRaw = await fs.readFile(configPath, "utf8");
    expect(updatedRaw).toContain("// Main Cursor MCP config");
    expect(updatedRaw).toContain('"myagent-legacy"');
    expect(updatedRaw).toContain('"custom-tool"');
    expect(updatedRaw).toContain('"obagents"');
    expect(updatedRaw).not.toContain('"obagents-swe-123456"');

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Legacy MCP entry "myagent-legacy" detected/),
    );

    // Test idempotence
    const firstRunContent = updatedRaw;
    await manageMcpConfig({
      agentName: "swe",
      projectDir: PROJECT,
      configPath,
      format: "mcpServers",
      action: "link",
    });
    const secondRunContent = await fs.readFile(configPath, "utf8");
    expect(secondRunContent).toBe(firstRunContent);
  });

  it("migrates servers format (Copilot): strips obagents-*, preserves myagent-* & custom", async () => {
    const configPath = "/virtual/project/.vscode/mcp.json";
    const initialContent = `{
  "servers": {
    "obagents-swe-123456": { "type": "stdio", "command": "obagents", "args": ["serve"] },
    "myagent-legacy": { "type": "stdio", "command": "myagent", "args": [] },
    "custom-mcp": { "type": "stdio", "command": "custom", "args": [] }
  }
}`;
    await fs.mkdir("/virtual/project/.vscode", { recursive: true });
    await fs.writeFile(configPath, initialContent, "utf8");

    const warningSpy = vi.spyOn(logger, "warning");

    await manageMcpConfig({
      agentName: "swe",
      projectDir: PROJECT,
      configPath,
      format: "servers",
      action: "link",
    });

    const parsed = parseJsonc(await fs.readFile(configPath, "utf8")) as any;
    expect(parsed.servers["obagents-swe-123456"]).toBeUndefined();
    expect(parsed.servers["myagent-legacy"]).toEqual({ type: "stdio", command: "myagent", args: [] });
    expect(parsed.servers["custom-mcp"]).toEqual({ type: "stdio", command: "custom", args: [] });
    expect(parsed.servers["obagents"]).toBeDefined();

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Legacy MCP entry "myagent-legacy" detected/),
    );
  });

  it("migrates opencode format (OpenCode CLI): strips obagents-*, preserves myagent-* & custom", async () => {
    const configPath = "/virtual/project/opencode.json";
    const initialContent = `{
  "mcp": {
    "obagents-swe-123456": { "type": "local", "command": ["obagents", "serve"], "cwd": "." },
    "myagent-legacy": { "type": "local", "command": ["myagent"], "cwd": "." },
    "custom-mcp": { "type": "local", "command": ["custom"], "cwd": "." }
  }
}`;
    await fs.writeFile(configPath, initialContent, "utf8");

    const warningSpy = vi.spyOn(logger, "warning");

    await manageMcpConfig({
      agentName: "swe",
      projectDir: PROJECT,
      configPath,
      format: "opencode",
      action: "link",
    });

    const parsed = parseJsonc(await fs.readFile(configPath, "utf8")) as any;
    expect(parsed.mcp["obagents-swe-123456"]).toBeUndefined();
    expect(parsed.mcp["myagent-legacy"]).toEqual({ type: "local", command: ["myagent"], cwd: "." });
    expect(parsed.mcp["custom-mcp"]).toEqual({ type: "local", command: ["custom"], cwd: "." });
    expect(parsed.mcp["obagents"]).toBeDefined();

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Legacy MCP entry "myagent-legacy" detected/),
    );
  });

  it("migrates array format (Continue): strips obagents-*, preserves myagent-* & custom", async () => {
    const configPath = "/virtual/project/.continue/config.json";
    const initialContent = `{
  "mcpServers": [
    { "name": "obagents-swe-123456", "type": "stdio", "command": "obagents", "args": ["serve"] },
    { "name": "myagent-legacy", "type": "stdio", "command": "myagent", "args": [] },
    { "name": "custom-mcp", "type": "stdio", "command": "custom", "args": [] }
  ]
}`;
    await fs.mkdir("/virtual/project/.continue", { recursive: true });
    await fs.writeFile(configPath, initialContent, "utf8");

    const warningSpy = vi.spyOn(logger, "warning");

    await manageMcpConfig({
      agentName: "swe",
      projectDir: PROJECT,
      configPath,
      format: "array",
      action: "link",
    });

    const parsed = parseJsonc(await fs.readFile(configPath, "utf8")) as any;
    expect(parsed.mcpServers.find((s: any) => s.name === "obagents-swe-123456")).toBeUndefined();
    expect(parsed.mcpServers.find((s: any) => s.name === "myagent-legacy")).toEqual({
      name: "myagent-legacy",
      type: "stdio",
      command: "myagent",
      args: [],
    });
    expect(parsed.mcpServers.find((s: any) => s.name === "custom-mcp")).toEqual({
      name: "custom-mcp",
      type: "stdio",
      command: "custom",
      args: [],
    });
    expect(parsed.mcpServers.find((s: any) => s.name === "obagents")).toBeDefined();

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Legacy MCP entry "myagent-legacy" detected/),
    );
  });

  it("integration: link, sync, gateway install, and diff work seamlessly with auto-migration", async () => {
    const mcpPath = pathResolver.getCursorMcpPath();
    await fs.mkdir("/virtual/home/.cursor", { recursive: true });
    await fs.writeFile(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "obagents-swe-stale": { command: "obagents", args: ["serve"] },
          "myagent-old": { command: "myagent", args: [] },
        },
      }),
      "utf8",
    );

    // 1. Link agent
    await vaultSyncEngine.linkAgent("swe", { targets: ["cursor"], projectDir: PROJECT });

    // Verify stale entry removed, obagents gateway added, myagent-old preserved
    let raw = await fs.readFile(mcpPath, "utf8");
    let parsed = parseJsonc(raw) as any;
    expect(parsed.mcpServers["obagents-swe-stale"]).toBeUndefined();
    expect(parsed.mcpServers["myagent-old"]).toBeDefined();
    expect(parsed.mcpServers["obagents"]).toBeDefined();

    // 2. diff reports in-sync
    const diffRes = await diffProject(PROJECT);
    const cursorDiff = diffRes.targets.find((t) => t.key === "cursor");
    expect(cursorDiff?.status).toBe("in-sync");

    // 3. Re-inject stale entry to simulate pre-migrated state
    parsed.mcpServers["obagents-swe-stale2"] = { command: "obagents", args: ["serve"] };
    await fs.writeFile(mcpPath, JSON.stringify(parsed), "utf8");

    // diff reports drifted
    const driftedDiff = await diffProject(PROJECT);
    expect(driftedDiff.targets.find((t) => t.key === "cursor")?.status).toBe("drifted");

    // fixDrift auto-migrates and fixes drift
    const fixRes = await fixDrift(PROJECT);
    expect(fixRes.fixed).toContain("cursor");

    const afterFixDiff = await diffProject(PROJECT);
    expect(afterFixDiff.targets.find((t) => t.key === "cursor")?.status).toBe("in-sync");

    // 4. installGateway also auto-migrates stale entries
    parsed.mcpServers["obagents-stale-gw"] = { command: "obagents", args: ["serve"] };
    await fs.writeFile(mcpPath, JSON.stringify(parsed), "utf8");

    await installGateway();
    raw = await fs.readFile(mcpPath, "utf8");
    parsed = parseJsonc(raw) as any;
    expect(parsed.mcpServers["obagents-stale-gw"]).toBeUndefined();
    expect(parsed.mcpServers["obagents"]).toBeDefined();
  });
});
