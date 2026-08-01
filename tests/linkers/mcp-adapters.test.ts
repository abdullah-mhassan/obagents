import { describe, it, expect } from "vitest";
import { adapters } from "../../src/linker/adapters/mcp.js";
import { parseJsonc, manageMcpConfig } from "../../src/linker/mcp.js";
import { useMemoryFileSystem, useNodeFileSystem, fs } from "../../src/utils/fs.js";

describe("MCP Format Adapters", () => {
  const serverName = "obagents-test-1234567890ab";
  const command = "obagents";
  const args = ["serve", "test", "--project", "/app"];

  describe("mcpServers format (Cursor, Windsurf, Roo)", () => {
    const adapter = adapters.mcpServers;
    it("injects configuration", () => {
      const result = adapter.inject({}, serverName, command, args);
      expect(result.mcpServers[serverName]).toEqual({ command, args });
    });
    it("retracts configuration", () => {
      const config = { mcpServers: { [serverName]: { command, args } } };
      const result = adapter.retract(config, serverName, "test");
      expect(result.mcpServers[serverName]).toBeUndefined();
    });
  });

  describe("servers format (GitHub Copilot)", () => {
    const adapter = adapters.servers;
    it("injects configuration", () => {
      const result = adapter.inject({}, serverName, command, args);
      expect(result.servers[serverName]).toEqual({ type: "stdio", command, args });
    });
    it("retracts configuration", () => {
      const config = { servers: { [serverName]: { type: "stdio", command, args } } };
      const result = adapter.retract(config, serverName, "test");
      expect(result.servers[serverName]).toBeUndefined();
    });
  });

  describe("opencode format", () => {
    const adapter = adapters.opencode;
    it("injects configuration into named server map", () => {
      const result = adapter.inject({}, serverName, command, args);
      expect(result.mcp[serverName]).toEqual({
        type: "local",
        command: [command, ...args],
        cwd: ".",
      });
    });
    it("retracts configuration by server key", () => {
      const config = {
        mcp: {
          [serverName]: {
            type: "local",
            command: [command, ...args],
            cwd: ".",
          },
        },
      };
      const result = adapter.retract(config, serverName, "test");
      expect(result.mcp[serverName]).toBeUndefined();
    });
  });

  describe("array format (Continue)", () => {
    const adapter = adapters.array;
    it("injects configuration into empty or non-array config", () => {
      const result = adapter.inject({}, serverName, command, args);
      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0]).toEqual({ name: serverName, type: "stdio", command, args });
    });
    it("retracts configuration", () => {
      const config = {
        mcpServers: [{ name: serverName, type: "stdio", command, args }],
      };
      const result = adapter.retract(config, serverName, "test");
      expect(result.mcpServers).toHaveLength(0);
    });
  });

  describe("JSONC parser & error handling", () => {
    it("parses single-line and multi-line comments and trailing commas", () => {
      const jsonc = `{
        // single line comment
        "name": "test", /* block comment */
        "items": [
          "a",
          "b",
        ],
      }`;
      const parsed = parseJsonc(jsonc);
      expect(parsed).toEqual({ name: "test", items: ["a", "b"] });
    });

    it("throws actionable Error on malformed JSONC in manageMcpConfig", async () => {
      useMemoryFileSystem();
      try {
        const configPath = "/test/mcp.json";
        await fs.writeFile(configPath, "{ malformed json: true, }", "utf8");
        await expect(
          manageMcpConfig({
            agentName: "test",
            projectDir: "/test",
            configPath,
            format: "mcpServers",
            action: "link",
          }),
        ).rejects.toThrow("Failed to parse MCP configuration file at /test/mcp.json");
      } finally {
        useNodeFileSystem();
      }
    });
  });
});
