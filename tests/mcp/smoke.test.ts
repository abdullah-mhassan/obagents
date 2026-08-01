import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer } from "../../src/mcp/server.js";
import { createAgent } from "../../src/vault/agent.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { openDatabase } from "../../src/memory/db.js";
import { searchHistory } from "../../src/memory/fts.js";
import { SUPPORTED_TARGETS } from "../../src/utils/constants.js";

const vault = mkdtempSync(join(tmpdir(), "obagents-mcp-"));
const project = mkdtempSync(join(tmpdir(), "obagents-proj-"));
const project2 = mkdtempSync(join(tmpdir(), "obagents-proj2-"));
const project3 = mkdtempSync(join(tmpdir(), "obagents-proj3-"));
overrideVaultRoot(vault);

interface CallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function parse(res: CallResult): any {
  if (res.isError) throw new Error("tool error: " + JSON.stringify(res.content));
  return JSON.parse(res.content[0].text);
}

function memoryContains(dbPathAgent: string, content: string): boolean {
  const db = openDatabase({ agentName: dbPathAgent });
  try {
    const hits = searchHistory(db, content, { agentName: dbPathAgent });
    return hits.some((h) => h.source === "memory" && h.content.includes(content));
  } finally {
    db.close();
  }
}

async function withServer(projectDir: string, fn: (client: Client) => Promise<void>): Promise<void> {
  const server = createGatewayMcpServer(projectDir);
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

describe("MCP Hive gateway day-in-life (in-process client)", () => {
  beforeAll(async () => {
    await createAgent("host", { description: "host agent" });
    await createAgent("worker", { description: "worker agent" });
    await createAgent("stranger", { description: "stranger agent" });
  });

  it("resolves the Hive per tool call: roster targeting, project routing, roster enforcement", async () => {
    await withServer(project, async (client) => {
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
        "learn_skill",
      ]) {
        expect(names, `tool ${n} registered`).toContain(n);
      }

      // Build the roster: host is linked first and becomes the Active Runtime Agent.
      const linkHost = parse(await client.callTool({ name: "link_agent", arguments: { name: "host", targets: ["cursor"], projectPath: project } }));
      expect(linkHost.success).toBe(true);
      const linkWorker = parse(await client.callTool({ name: "link_agent", arguments: { name: "worker", targets: ["cursor"], projectPath: project } }));
      expect(linkWorker.success).toBe(true);

      // Default targeting writes to the Active Runtime Agent (host).
      const hostUpd = parse(await client.callTool({ name: "update_state", arguments: { type: "build-fixed", summary: "host fixed the login bug" } }));
      expect(hostUpd.success).toBe(true);
      expect(memoryContains("host", "login bug")).toBe(true);

      // Explicit targetAgent routes to another roster agent (worker).
      const workerUpd = parse(await client.callTool({ name: "update_state", arguments: { type: "milestone", summary: "worker milestone shipped", targetAgent: "worker" } }));
      expect(workerUpd.success).toBe(true);
      expect(memoryContains("worker", "worker milestone shipped")).toBe(true);

      // read_state routes to the requested agent's compiled state.
      const workerRead = parse(await client.callTool({ name: "read_state", arguments: { targetAgent: "worker" } }));
      expect(typeof workerRead.memory).toBe("string");
      expect(workerRead.memory).toContain("# worker");
      expect(workerRead.memory).not.toContain("# host");

      // Default read reflects the active agent (host).
      const hostRead = parse(await client.callTool({ name: "read_state", arguments: {} }));
      expect(hostRead.memory).toContain("# host");
      expect(hostRead.memory).not.toContain("# worker");

      // Hive read tools honor the roster.
      const loaded = parse(await client.callTool({ name: "load_agent_context", arguments: { targetAgent: "worker" } }));
      expect(typeof loaded.memory).toBe("string");

      const consulted = parse(await client.callTool({ name: "consult_agent", arguments: { targetAgent: "host", query: "login" } }));
      expect(consulted.results.length).toBeGreaterThan(0);

      // Agents outside the roster are rejected with a clear message.
      const strangerLoad = await client.callTool({ name: "load_agent_context", arguments: { targetAgent: "stranger" } });
      expect(strangerLoad.isError).toBe(true);
      expect(JSON.stringify(strangerLoad.content)).toContain("not linked");

      const strangerUpd = await client.callTool({ name: "update_state", arguments: { type: "milestone", summary: "x", targetAgent: "stranger" } });
      expect(strangerUpd.isError).toBe(true);
      expect(JSON.stringify(strangerUpd.content)).toContain("not linked");

      // Explicit project routing: worker is also linked to a second project.
      const linkWorker2 = parse(await client.callTool({ name: "link_agent", arguments: { name: "worker", targets: ["cursor"], projectPath: project2 } }));
      expect(linkWorker2.success).toBe(true);
      const routed = parse(await client.callTool({ name: "read_state", arguments: { targetAgent: "worker", project: project2 } }));
      expect(typeof routed.memory).toBe("string");
      expect(routed.memory).toContain("# worker");

      // A directory with no linked agents errors with a hint.
      const unlinked = await client.callTool({ name: "read_state", arguments: { project: project3 } });
      expect(unlinked.isError).toBe(true);
      expect(JSON.stringify(unlinked.content)).toContain("No agents are linked");
    });
  });

  it("advertises the real supported targets in link_agent", async () => {
    await withServer(project, async (client) => {
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
  rmSync(project2, { recursive: true, force: true });
  rmSync(project3, { recursive: true, force: true });
});
