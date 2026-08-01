import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideVaultRoot, getAgentDir } from "../../src/utils/paths.js";
import { createAgent } from "../../src/vault/agent.js";
import { openDatabase, type DatabaseType } from "../../src/memory/db.js";
import { registerTools } from "../../src/mcp/index.js";
import { addEpisode, searchHistory, countNearDuplicates } from "../../src/memory/fts.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface CapturedTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

function captureTools(server: McpServer): CapturedTool[] {
  const captured: CapturedTool[] = [];
  const originalTool = server.tool.bind(server);
  (server as unknown as {
    tool: (name: string, description: string, schema: Record<string, unknown>, cb: (args: Record<string, unknown>) => Promise<unknown>) => unknown;
  }).tool = function patchedTool(name, description, schema, cb) {
    captured.push({
      name,
      handler: async (args) => (await cb(args)) as { content: { type: string; text: string }[]; isError?: boolean },
    });
    return originalTool(name as never, description as never, schema as never, cb as never);
  };
  return captured;
}

let tmpRoot: string;
let db: DatabaseType;

async function setup(agentName: string, projectDir?: string): Promise<Map<string, CapturedTool>> {
  if (!existsSync(getAgentDir(agentName))) {
    await createAgent(agentName);
  }
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const captured = captureTools(server);
  registerTools(server, agentName, { db, projectDir });
  return new Map(captured.map((t) => [t.name, t]));
}

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const PROJECT_A = "/projects/alpha";
const PROJECT_B = "/projects/beta";

describe("project-scoped memory", () => {
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "obagents-proj-"));
    overrideVaultRoot(tmpRoot);
    db = openDatabase({ agentName: "test", inMemory: true });
  });

  afterEach(async () => {
    db.close();
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  });

  it("tags entries with the served project and isolates search across projects", async () => {
    const toolsA = await setup("scoped-agent", PROJECT_A);
    const toolsB = await setup("scoped-agent", PROJECT_B);

    await toolsA.get("update_state")!.handler({ type: "bug-fixed", summary: "login crash on empty token" });
    await toolsB.get("update_state")!.handler({ type: "milestone", summary: "shipped onboarding flow" });

    const inA = searchHistory(db, "login", { agentName: "scoped-agent", project: PROJECT_A });
    expect(inA.length).toBe(1);
    expect(inA[0]!.content).toContain("login crash");

    const inB = searchHistory(db, "login", { agentName: "scoped-agent", project: PROJECT_B });
    expect(inB.length).toBe(0);

    const inBmilestone = searchHistory(db, "onboarding", { agentName: "scoped-agent", project: PROJECT_B });
    expect(inBmilestone.length).toBe(1);
  });

  it("auto-resolves project from serve --project without an explicit arg", async () => {
    const tools = await setup("scoped-agent", PROJECT_A);
    const result = await tools.get("update_state")!.handler({ type: "decision", summary: "use postgres for writes" });
    const body = parse(result) as { project: string };
    expect(body.project).toBe(PROJECT_A);
  });

  it("honors an explicit project override over the served project", async () => {
    const tools = await setup("scoped-agent", PROJECT_A);
    const result = await tools.get("update_state")!.handler({ type: "decision", summary: "cache with redis", project: PROJECT_B });
    const body = parse(result) as { project: string };
    expect(body.project).toBe(PROJECT_B);
  });

  it("countNearDuplicates flags semantically similar rows but not dissimilar ones", async () => {
    addEpisode(db, { agentName: "scoped-agent", source: "memory", content: "fixed the login bug that crashed on empty token", tags: `bug-fixed,${PROJECT_A}` });
    addEpisode(db, { agentName: "scoped-agent", source: "memory", content: "the login bug is now fixed after handling empty tokens", tags: `bug-fixed,${PROJECT_A}` });
    addEpisode(db, { agentName: "scoped-agent", source: "memory", content: "deployed the staging environment to eu west one region", tags: `milestone,${PROJECT_A}` });

    const dupes = countNearDuplicates(db, "scoped-agent", PROJECT_A);
    expect(dupes).toBeGreaterThanOrEqual(1);
  });

  it("flips needsConsolidation on the dedup trigger even under the row threshold", async () => {
    const tools = await setup("scoped-agent", PROJECT_A);
    const similar = [
      "onboarding flow uses email verification step now",
      "onboarding now requires email verification before continuing",
      "email verification is part of the onboarding step today",
    ];
    let last: Record<string, unknown> = {};
    for (const s of similar) {
      last = parse(await tools.get("update_state")!.handler({ type: "milestone", summary: s }));
    }
    expect((last as { needsConsolidation: boolean }).needsConsolidation).toBe(true);
    expect((last as { nearDuplicates: number }).nearDuplicates).toBeGreaterThanOrEqual(1);
  });

  it("read_state returns the project-scoped working memory content rather than the global one", async () => {
    const toolsA = await setup("scoped-agent", PROJECT_A);
    const { getCoreFilePath } = await import("../../src/vault/project.js");
    const { fs } = await import("../../src/utils/fs.js");
    const { dirname } = await import("node:path");
    
    // Write some content to the global memory and the scoped memory.
    await fs.writeFile(getCoreFilePath("scoped-agent", "MEMORY.md"), "GLOBAL MEMORY");
    
    const scopedPath = getCoreFilePath("scoped-agent", "MEMORY.md", PROJECT_A);
    await fs.mkdir(dirname(scopedPath), { recursive: true });
    await fs.writeFile(scopedPath, "SCOPED MEMORY A");

    const result = await toolsA.get("read_state")!.handler({});
    const body = parse(result) as { memory: string };
    
    expect(body.memory).toContain("SCOPED MEMORY A");
    expect(body.memory).not.toContain("GLOBAL MEMORY");
  });
  it("searchHistory with includeNeutral=true returns project-scoped memories and global skills", async () => {
    addEpisode(db, { agentName: "scoped-agent", source: "skill", content: "I am a global skill", tags: "skill,myskill" });
    addEpisode(db, { agentName: "scoped-agent", source: "memory", content: "I am a project memory", tags: `milestone,${PROJECT_A}` });
    
    // searchHistory defaults to global=false and includeNeutral=true
    const inA = searchHistory(db, "global OR project", { agentName: "scoped-agent", project: PROJECT_A });
    expect(inA.length).toBe(2);
  });

  it("search_history tool with global: true searches all project memories", async () => {
    const tools = await setup("scoped-agent", PROJECT_A);
    addEpisode(db, { agentName: "scoped-agent", source: "memory", content: "This is from B", tags: `milestone,${PROJECT_B}` });
    const result = await tools.get("search_history")!.handler({ query: "from", global: true });
    const body = parse(result) as { results: unknown[] };
    expect(body.results.length).toBe(1);
  });

  it("update_state allows identical milestone summary in independent projects without duplicate flag", async () => {
    const toolsA = await setup("scoped-agent", PROJECT_A);
    const toolsB = await setup("scoped-agent", PROJECT_B);

    const summary = "Completed Ticket 3 milestone";
    const resA = parse(await toolsA.get("update_state")!.handler({ type: "milestone", summary }));
    expect(resA.duplicate).toBeUndefined();

    // Updating state with same summary in PROJECT_B should NOT be treated as a duplicate of PROJECT_A
    const resB = parse(await toolsB.get("update_state")!.handler({ type: "milestone", summary }));
    expect(resB.duplicate).toBeUndefined();

    // Updating state with same summary in PROJECT_A SHOULD be treated as duplicate
    const resA2 = parse(await toolsA.get("update_state")!.handler({ type: "milestone", summary }));
    expect(resA2.duplicate).toBe(true);
  });

  it("consult_agent isolates memory search results to served project", async () => {
    const toolsA = await setup("scoped-agent", PROJECT_A);
    const toolsB = await setup("scoped-agent", PROJECT_B);

    await toolsA.get("update_state")!.handler({ type: "decision", summary: "database choice: Project A uses PostgreSQL" });
    await toolsB.get("update_state")!.handler({ type: "decision", summary: "database choice: Project B uses MongoDB" });

    const consultA = parse(await toolsA.get("consult_agent")!.handler({ targetAgent: "scoped-agent", query: "database" })) as { results: Array<{ content: string }> };
    expect(consultA.results.some((r) => r.content.includes("PostgreSQL"))).toBe(true);
    expect(consultA.results.some((r) => r.content.includes("MongoDB"))).toBe(false);
  });

  it("validateAgentName rejects empty/invalid agent names and path traversal attempts", async () => {
    const { validateAgentName } = await import("../../src/vault/agent.js");

    expect(validateAgentName("@valid-agent")).toBe("valid-agent");
    expect(() => validateAgentName("")).toThrow();
    expect(() => validateAgentName("@")).toThrow();
    expect(() => validateAgentName("../traversal")).toThrow();
    expect(() => validateAgentName("foo/bar")).toThrow();
  });
});
