import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createAgent } from "../../src/vault/agent.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { getCoreFilePath } from "../../src/vault/project.js";
import { SUPPORTED_TARGETS } from "../../src/utils/constants.js";

const vault = mkdtempSync(join(tmpdir(), "obagents-mcp-"));
const project = mkdtempSync(join(tmpdir(), "obagents-proj-"));
overrideVaultRoot(vault);

interface CallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function parse(res: CallResult): any {
  if (res.isError) throw new Error("tool error: " + JSON.stringify(res.content));
  return JSON.parse(res.content[0].text);
}

async function withServer(agent: string, projectDir: string, fn: (client: Client) => Promise<void>): Promise<void> {
  const server = createMcpServer(agent, projectDir);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await server.connect(serverT);
  await client.connect(clientT);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP server day-in-life (in-process client)", () => {
  beforeAll(async () => {
    await createAgent("host", { description: "host agent" });
  });

  it("spawns a worker, links it, records/recalls memory, consolidates, and cross-consults", async () => {
    await withServer("host", project, async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      for (const n of [
        "create_agent",
        "link_agent",
        "update_state",
        "read_state",
        "search_history",
        "consolidate_agent",
        "load_agent_context",
        "consult_agent",
      ]) {
        expect(names, `tool ${n} registered`).toContain(n);
      }

      const created = parse(await client.callTool({ name: "create_agent", arguments: { name: "worker", description: "w" } }));
      expect(created.success).toBe(true);
      expect(existsSync(join(vault, "agents", "worker", "SOUL.md"))).toBe(true);

      const linked = parse(await client.callTool({ name: "link_agent", arguments: { name: "worker", targets: ["cursor"], projectPath: project } }));
      expect(linked.success).toBe(true);
      expect(existsSync(join(project, ".cursor", "rules", "obagents.mdc"))).toBe(true);

      const upd = parse(await client.callTool({ name: "update_state", arguments: { type: "build-fixed", summary: "fixed login bug" } }));
      expect(upd.success).toBe(true);
      expect(typeof upd.entryId).toBe("number");

      const read = parse(await client.callTool({ name: "read_state", arguments: {} }));
      expect(typeof read.memory).toBe("string");

      const search = parse(await client.callTool({ name: "search_history", arguments: { query: "login" } }));
      expect(Array.isArray(search.results)).toBe(true);
      expect(search.results.length).toBeGreaterThan(0);

      const cons = parse(await client.callTool({ name: "consolidate_agent", arguments: { name: "worker", summary: "worker consolidated" } }));
      expect(cons.success).toBe(true);
      expect(readFileSync(getCoreFilePath("worker", "MEMORY.md", project), "utf8")).toContain("worker consolidated");

      const loaded = parse(await client.callTool({ name: "load_agent_context", arguments: { targetAgent: "worker" } }));
      expect(typeof loaded.memory).toBe("string");

      const consulted = parse(await client.callTool({ name: "consult_agent", arguments: { targetAgent: "host", query: "login" } }));
      expect(consulted.results.length).toBeGreaterThan(0);
    });
  });

  it("advertises the real supported targets in link_agent", async () => {
    await withServer("host", project, async (client) => {
      const tools = await client.listTools();
      const link = tools.tools.find((t) => t.name === "link_agent");
      expect(link, "link_agent tool present").toBeDefined();
      const desc = link!.description as string;
      const match = desc.match(/Valid targets: \[([^\]]+)\]\./);
      expect(match, "description lists valid targets").not.toBeNull();
      const advertised = match![1].split(",").map((s) => s.trim());
      expect(advertised.sort()).toEqual([...SUPPORTED_TARGETS].sort());
    });
  });
});

afterAll(() => {
  overrideVaultRoot(null);
  rmSync(vault, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});
