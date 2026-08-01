import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { manageMcpConfig, parseJsonc } from "../../src/linker/mcp.js";
import { fs, useMemoryFileSystem } from "../../src/utils/fs.js";

describe("JSONC comment preservation in manageMcpConfig", () => {
  let memoryFS: ReturnType<typeof useMemoryFileSystem>;

  beforeEach(() => {
    memoryFS = useMemoryFileSystem();
  });

  afterEach(() => {
    memoryFS.files.clear();
  });

  it("parseJsonc parses comments and trailing commas", () => {
    const raw = `
      // Top level comment
      {
        "mcpServers": {
          /* inline comment */
          "other": { "command": "other" }, // trailing comment
        },
      }
    `;
    const parsed = parseJsonc(raw);
    expect(parsed.mcpServers).toBeDefined();
  });

  it("preserves line and block comments when linking to mcpServers format", async () => {
    const configPath = "/project/.cursor/mcp.json";
    const initialRaw = `// User custom configuration file
{
  /* Global options */
  "mcpServers": {
    // Key comment for existing server
    "existing": {
      "command": "node",
      "args": ["server.js"]
    }
  }
}
`;
    await fs.mkdir("/project/.cursor");
    await fs.writeFile(configPath, initialRaw);

    await manageMcpConfig({
      agentName: "dev-agent",
      projectDir: "/project",
      configPath,
      format: "mcpServers",
      action: "link",
      command: "obagents",
      args: ["serve", "dev-agent"],
      serverName: "obagents-dev-agent-1234",
    });

    const result = await fs.readFile(configPath);
    expect(result).toContain("// User custom configuration file");
    expect(result).toContain("/* Global options */");
    expect(result).toContain("// Key comment for existing server");
    expect(result).toContain('"obagents-dev-agent-1234"');
  });

  it("preserves comments when unlinking from servers format", async () => {
    const configPath = "/project/.vscode/mcp.json";
    const initialRaw = `// VSCode settings
{
  // Main servers dictionary
  "servers": {
    "obagents-dev-agent-1234": {
      "type": "stdio",
      "command": "obagents",
      "args": ["serve", "dev-agent"]
    },
    "other": {
      /* Other tool */
      "type": "stdio",
      "command": "other"
    }
  }
}
`;
    await fs.mkdir("/project/.vscode");
    await fs.writeFile(configPath, initialRaw);

    await manageMcpConfig({
      agentName: "dev-agent",
      projectDir: "/project",
      configPath,
      format: "servers",
      action: "unlink",
      serverName: "obagents-dev-agent-1234",
    });

    const result = await fs.readFile(configPath);
    expect(result).toContain("// VSCode settings");
    expect(result).toContain("// Main servers dictionary");
    expect(result).toContain("/* Other tool */");
    expect(result).not.toContain('"obagents-dev-agent-1234"');
  });

  it("preserves comments when linking to opencode format", async () => {
    const configPath = "/project/opencode.json";
    const initialRaw = `// OpenCode configuration
{
  /* MCP Section */
  "mcp": {}
}
`;
    await fs.writeFile(configPath, initialRaw);

    await manageMcpConfig({
      agentName: "dev-agent",
      projectDir: "/project",
      configPath,
      format: "opencode",
      action: "link",
      command: "obagents",
      args: ["serve", "dev-agent"],
      serverName: "obagents-dev-agent-1234",
    });

    const result = await fs.readFile(configPath);
    expect(result).toContain("// OpenCode configuration");
    expect(result).toContain("/* MCP Section */");
    expect(result).toContain('"obagents-dev-agent-1234"');
  });

  it("preserves comments when linking to array format (Continue)", async () => {
    const configPath = "/project/.continue/config.json";
    const initialRaw = `// my server list
{
  /* MCP Section */
  "mcpServers": [
    // existing server
    { "name": "existing", "command": "node" }
  ]
}
`;
    await fs.mkdir("/project/.continue");
    await fs.writeFile(configPath, initialRaw);

    await manageMcpConfig({
      agentName: "dev-agent",
      projectDir: "/project",
      configPath,
      format: "array",
      action: "link",
      command: "obagents",
      args: ["serve", "dev-agent"],
      serverName: "obagents-dev-agent-1234",
    });

    const result = await fs.readFile(configPath);
    expect(result).toContain("// my server list");
    expect(result).toContain("/* MCP Section */");
    expect(result).toContain('"name": "obagents-dev-agent-1234"');
    const parsed = parseJsonc(result);
    expect(parsed.mcpServers).toHaveLength(2);
    expect(parsed.mcpServers[1]).toEqual({
      name: "obagents-dev-agent-1234",
      type: "stdio",
      command: "obagents",
      args: ["serve", "dev-agent"],
    });
  });

  it("preserves comments across an array-format link/unlink round-trip", async () => {
    const configPath = "/project/.continue/config.json";
    const initialRaw = `// my server list
{
  "mcpServers": [
    /* other tool */
    { "name": "other", "command": "other" }
  ]
}
`;
    await fs.mkdir("/project/.continue");
    await fs.writeFile(configPath, initialRaw);

    await manageMcpConfig({
      agentName: "dev-agent",
      projectDir: "/project",
      configPath,
      format: "array",
      action: "link",
      command: "obagents",
      args: ["serve", "dev-agent"],
      serverName: "obagents-dev-agent-1234",
    });
    const afterLink = await fs.readFile(configPath);
    expect(afterLink).toContain("// my server list");
    expect(afterLink).toContain("/* other tool */");
    expect(parseJsonc(afterLink).mcpServers).toHaveLength(2);

    await manageMcpConfig({
      agentName: "dev-agent",
      projectDir: "/project",
      configPath,
      format: "array",
      action: "unlink",
      serverName: "obagents-dev-agent-1234",
    });
    const afterUnlink = await fs.readFile(configPath);
    expect(afterUnlink).toContain("// my server list");
    expect(afterUnlink).toContain("/* other tool */");
    expect(parseJsonc(afterUnlink).mcpServers).toHaveLength(1);
  });

  it("creates the mcpServers array when linking to array format without one", async () => {
    const configPath = "/project/.continue/config.json";
    const initialRaw = `// my config
{
  "experimental": { "enabled": true }
}
`;
    await fs.mkdir("/project/.continue");
    await fs.writeFile(configPath, initialRaw);

    await manageMcpConfig({
      agentName: "dev-agent",
      projectDir: "/project",
      configPath,
      format: "array",
      action: "link",
      command: "obagents",
      args: ["serve", "dev-agent"],
      serverName: "obagents-dev-agent-1234",
    });

    const result = await fs.readFile(configPath);
    const parsed = parseJsonc(result);
    expect(parsed.mcpServers).toHaveLength(1);
    expect(parsed.mcpServers[0].name).toBe("obagents-dev-agent-1234");
    expect(parsed.experimental).toEqual({ enabled: true });
  });
});
