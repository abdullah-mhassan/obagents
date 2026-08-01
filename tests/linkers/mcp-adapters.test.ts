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
    it("strips stale obagents-* entries and preserves legacy myagent-* and custom entries", () => {
      const config = {
        mcpServers: {
          "obagents-swe-123456": { command: "obagents", args: ["serve"] },
          "myagent-legacy": { command: "myagent", args: [] },
          "custom-tool": { command: "custom-tool", args: [] },
        },
      };
      const result = adapter.inject(config, "obagents", command, args);
      expect(result.mcpServers["obagents-swe-123456"]).toBeUndefined();
      expect(result.mcpServers["myagent-legacy"]).toEqual({ command: "myagent", args: [] });
      expect(result.mcpServers["custom-tool"]).toEqual({ command: "custom-tool", args: [] });
      expect(result.mcpServers["obagents"]).toEqual({ command, args });
    });
    it("reports drifted in checkRegistration when stale obagents-* entry is present", () => {
      const config = {
        mcpServers: {
          obagents: { command, args },
          "obagents-swe-123456": { command, args },
        },
      };
      const res = adapter.checkRegistration(config, "obagents", command, args);
      expect(res.status).toBe("drifted");
      expect(res.diff).toContain("obagents-swe-123456");
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
    it("strips stale obagents-* entries and preserves legacy myagent-* and custom entries", () => {
      const config = {
        servers: {
          "obagents-swe-123456": { type: "stdio", command: "obagents", args: ["serve"] },
          "myagent-legacy": { type: "stdio", command: "myagent", args: [] },
          "custom-tool": { type: "stdio", command: "custom-tool", args: [] },
        },
      };
      const result = adapter.inject(config, "obagents", command, args);
      expect(result.servers["obagents-swe-123456"]).toBeUndefined();
      expect(result.servers["myagent-legacy"]).toEqual({ type: "stdio", command: "myagent", args: [] });
      expect(result.servers["custom-tool"]).toEqual({ type: "stdio", command: "custom-tool", args: [] });
      expect(result.servers["obagents"]).toEqual({ type: "stdio", command, args });
    });
    it("reports drifted in checkRegistration when stale obagents-* entry is present", () => {
      const config = {
        servers: {
          obagents: { type: "stdio", command, args },
          "obagents-swe-123456": { type: "stdio", command, args },
        },
      };
      const res = adapter.checkRegistration(config, "obagents", command, args);
      expect(res.status).toBe("drifted");
      expect(res.diff).toContain("obagents-swe-123456");
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
    it("strips stale obagents-* entries and preserves legacy myagent-* and custom entries", () => {
      const config = {
        mcp: {
          "obagents-swe-123456": { type: "local", command: ["obagents", "serve"], cwd: "." },
          "myagent-legacy": { type: "local", command: ["myagent"], cwd: "." },
          "custom-tool": { type: "local", command: ["custom-tool"], cwd: "." },
        },
      };
      const result = adapter.inject(config, "obagents", command, args);
      expect(result.mcp["obagents-swe-123456"]).toBeUndefined();
      expect(result.mcp["myagent-legacy"]).toEqual({ type: "local", command: ["myagent"], cwd: "." });
      expect(result.mcp["custom-tool"]).toEqual({ type: "local", command: ["custom-tool"], cwd: "." });
      expect(result.mcp["obagents"]).toEqual({ type: "local", command: [command, ...args], cwd: "." });
    });
    it("reports drifted in checkRegistration when stale obagents-* entry is present", () => {
      const config = {
        mcp: {
          obagents: { type: "local", command: [command, ...args], cwd: "." },
          "obagents-swe-123456": { type: "local", command: [command, ...args], cwd: "." },
        },
      };
      const res = adapter.checkRegistration(config, "obagents", command, args);
      expect(res.status).toBe("drifted");
      expect(res.diff).toContain("obagents-swe-123456");
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
    it("strips stale obagents-* entries and preserves legacy myagent-* and custom entries", () => {
      const config = {
        mcpServers: [
          { name: "obagents-swe-123456", type: "stdio", command: "obagents", args: ["serve"] },
          { name: "myagent-legacy", type: "stdio", command: "myagent", args: [] },
          { name: "custom-tool", type: "stdio", command: "custom-tool", args: [] },
        ],
      };
      const result = adapter.inject(config, "obagents", command, args);
      expect(result.mcpServers.find((s: any) => s.name === "obagents-swe-123456")).toBeUndefined();
      expect(result.mcpServers.find((s: any) => s.name === "myagent-legacy")).toEqual({
        name: "myagent-legacy",
        type: "stdio",
        command: "myagent",
        args: [],
      });
      expect(result.mcpServers.find((s: any) => s.name === "custom-tool")).toEqual({
        name: "custom-tool",
        type: "stdio",
        command: "custom-tool",
        args: [],
      });
      expect(result.mcpServers.find((s: any) => s.name === "obagents")).toEqual({
        name: "obagents",
        type: "stdio",
        command,
        args,
      });
    });
    it("reports drifted in checkRegistration when stale obagents-* entry is present", () => {
      const config = {
        mcpServers: [
          { name: "obagents", type: "stdio", command, args },
          { name: "obagents-swe-123456", type: "stdio", command, args },
        ],
      };
      const res = adapter.checkRegistration(config, "obagents", command, args);
      expect(res.status).toBe("drifted");
      expect(res.diff).toContain("obagents-swe-123456");
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
