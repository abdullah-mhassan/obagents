import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideVaultRoot, getAgentDir } from "../../src/utils/paths.js";
import { getCoreFilePath } from "../../src/vault/project.js";
import { createAgent, agentExists } from "../../src/vault/agent.js";
import { openDatabase, type DatabaseType } from "../../src/memory/db.js";
import { registerTools } from "../../src/mcp/index.js";
import { NAME_PATTERN } from "../../src/utils/constants.js";
import { searchHistory, addEpisode, listEpisodes } from "../../src/memory/fts.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

function captureTools(server: McpServer): CapturedTool[] {
  const captured: CapturedTool[] = [];
  const originalTool = server.tool.bind(server);

  // The SDK exposes multiple overloads; the (name, description, schema, cb) form is what tools.ts uses.
  // We patch with a loose signature and forward to the real registration so the server still holds them.
  (server as unknown as {
    tool: (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      cb: (args: Record<string, unknown>) => Promise<unknown>,
    ) => unknown;
  }).tool = function patchedTool(name, description, schema, cb) {
    captured.push({
      name,
      description,
      schema,
      handler: async (args) => (await cb(args)) as { content: { type: string; text: string }[]; isError?: boolean },
    });
    return originalTool(name as never, description as never, schema as never, cb as never);
  };

  return captured;
}

let tmpRoot: string;
let db: DatabaseType;
let captured: CapturedTool[];

let dbOpen = false;

async function setupAgent(agentName = "mcp-test"): Promise<{ agent: string; tools: Map<string, CapturedTool> }> {
  if (!tmpRoot) {
    tmpRoot = await mkdtemp(join(tmpdir(), "obagents-mcp-"));
    overrideVaultRoot(tmpRoot);
  }
  if (!dbOpen) {
    db = openDatabase({ agentName: "test", inMemory: true });
    dbOpen = true;
  }
  if (!existsSync(getAgentDir(agentName))) {
    await createAgent(agentName);
  }

  const server = new McpServer({ name: "test", version: "0.0.0" });
  captured = captureTools(server);
  registerTools(server, agentName, { db });

  const tools = new Map(captured.map((t) => [t.name, t]));
  return { agent: agentName, tools };
}

async function teardown(): Promise<void> {
  if (dbOpen && db) {
    db.close();
    dbOpen = false;
  }
  overrideVaultRoot(null);
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
}

function parseBody(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("registerTools", () => {
  beforeEach(async () => {
    await setupAgent();
  });
  afterEach(teardown);

  it("registers exactly 9 tools", () => {
    expect(captured.map((t) => t.name).sort()).toEqual([
      "consolidate_agent",
      "consult_agent",
      "create_agent",
      "learn_skill",
      "link_agent",
      "load_agent_context",
      "read_state",
      "search_history",
      "update_state",
    ]);
  });
});

describe("read_state tool", () => {
  beforeEach(async () => { await setupAgent(); });
  afterEach(teardown);

  it("returns the content of MEMORY.md for the agent", async () => {
    const { tools } = await setupAgent();
    const memoryPath = getCoreFilePath("mcp-test", "MEMORY.md");
    await writeFile(memoryPath, "current memory content", "utf8");

    const result = await tools.get("read_state")!.handler({});
    const body = parseBody(result) as { memory: string };
    expect(body.memory).toContain("current memory content");
  });

  it("returns empty memory when MEMORY.md is missing", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("read_state")!.handler({});
    expect(parseBody(result)).toEqual({ memory: expect.any(String) });
  });
});

describe("update_state tool", () => {
  beforeEach(async () => { await setupAgent(); });
  afterEach(teardown);

  it("records a typed structured entry and returns success", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("update_state")!.handler({
      type: "bug-fixed",
      summary: "fixed null deref in compiler",
    });
    const body = parseBody(result);
    expect(body).toMatchObject({ success: true, type: "bug-fixed", needsConsolidation: false });
    expect(typeof body.entryId).toBe("number");

    const hits = searchHistory(db, "compiler", { agentName: "mcp-test" });
    expect(hits.some((h) => h.source === "memory" && h.content.includes("null deref"))).toBe(true);
    expect(hits.some((h) => h.tags?.includes("bug-fixed"))).toBe(true);
  });

  it("rejects an old-style call (missing type/summary) with an explicit re-sync error", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("update_state")!.handler({ memory_text: "legacy call" });
    expect(result.isError).toBe(true);
    const body = parseBody(result);
    expect((body.error as string).toLowerCase()).toContain("re-run");
    expect((body.error as string).toLowerCase()).toContain("sync");
    // Nothing was written to the store
    expect(searchHistory(db, "legacy", { agentName: "mcp-test" }).length).toBe(0);
  });

  it("flags needsConsolidation once the threshold of entries since last consolidation is reached", async () => {
    const { tools } = await setupAgent();
    // Anchor a consolidation so "since last consolidation" is measured from now
    addEpisode(db, { agentName: "mcp-test", source: "consolidation", content: "prior summary", tags: "consolidation" });

    const distinctSummaries = [
      "shipped the authentication service",
      "configured the redis cache layer",
      "added rate limiting to the api gateway",
      "migrated sessions to postgres",
      "introduced the feature flag system",
      "wired up the stripe billing webhook",
      "built the admin dashboard route",
      "set up the ci pipeline on github actions",
      "added openapi documentation for the v2 endpoints",
      "implemented the password reset flow",
      "enabled structured logging with pino",
      "added the health check endpoint",
      "refactored the repository data layer",
      "introduced the event sourcing prototype",
      "configured the sentry error tracker",
      "added the multilingual locale support",
      "optimized the image upload pipeline",
      "built the notification dispatcher",
      "added the audit log table",
      "finalized the onboarding email sequence",
    ];
    for (let i = 0; i < 20; i++) {
      const r = await tools.get("update_state")!.handler({ type: "milestone", summary: distinctSummaries[i]! });
      const body = parseBody(r);
      if (i < 19) {
        expect(body.needsConsolidation).toBe(false);
      } else {
        expect(body.needsConsolidation).toBe(true);
        expect(body.rowsSinceConsolidation).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it("enforces the 2,000-character cap on update_state summaries", async () => {
    const { tools } = await setupAgent();
    const overCap = "a".repeat(2001);
    const result = await tools.get("update_state")!.handler({ type: "milestone", summary: overCap });
    expect(result.isError).toBe(true);
    const body = parseBody(result);
    expect((body.error as string)).toContain("cap");

    const exactlyCap = "a".repeat(2000);
    const okResult = await tools.get("update_state")!.handler({ type: "milestone", summary: exactlyCap });
    expect(okResult.isError).toBeFalsy();
  });

  it("handles valid supersedes parameter and rejects invalid/foreign target episode ID", async () => {
    const { tools } = await setupAgent();
    const r1 = await tools.get("update_state")!.handler({ type: "decision", summary: "use postgresql" });
    const b1 = parseBody(r1);

    const r2 = await tools.get("update_state")!.handler({ type: "decision", summary: "use sqlite", supersedes: b1.entryId as number });
    expect(r2.isError).toBeFalsy();
    const b2 = parseBody(r2);
    expect(b2.supersedes).toBe(b1.entryId);

    // Reject nonexistent supersedes ID
    const r3 = await tools.get("update_state")!.handler({ type: "decision", summary: "invalid supersedes", supersedes: 99999 });
    expect(r3.isError).toBe(true);
    expect((parseBody(r3).error as string)).toContain("not found");

    // Reject foreign agent's episode ID
    const foreignEp = addEpisode(db, { agentName: "other-agent", source: "memory", content: "foreign" });
    const r4 = await tools.get("update_state")!.handler({ type: "decision", summary: "supersede foreign", supersedes: foreignEp.id });
    expect(r4.isError).toBe(true);
    expect((parseBody(r4).error as string)).toContain("not found");
  });

  it("returns duplicate: true and reuses entryId when called with identical type and summary", async () => {
    const { tools } = await setupAgent();
    const r1 = await tools.get("update_state")!.handler({
      type: "milestone",
      summary: "implemented feature X",
    });
    const b1 = parseBody(r1);
    expect(b1.duplicate).toBeUndefined();

    const r2 = await tools.get("update_state")!.handler({
      type: "milestone",
      summary: "implemented feature X",
    });
    const b2 = parseBody(r2);
    expect(b2.success).toBe(true);
    expect(b2.duplicate).toBe(true);
    expect(b2.entryId).toBe(b1.entryId);

    const episodes = listEpisodes(db, "mcp-test").filter((e) => e.source === "memory");
    expect(episodes.length).toBe(1);
  });

  it("mirrors the recorded bullet into MEMORY.md so the compiled context reflects it live", async () => {
    const { tools } = await setupAgent();
    const r = await tools.get("update_state")!.handler({ type: "decision", summary: "use postgresql for storage" });
    const body = parseBody(r) as { memoryAppended: boolean };
    expect(body.memoryAppended).toBe(true);

    const memoryPath = getCoreFilePath("mcp-test", "MEMORY.md");
    const content = await readFile(memoryPath, "utf8");
    expect(content).toContain("## Latest state");
    expect(content).toContain("- decision: use postgresql for storage");

    const { compileAgentContext } = await import("../../src/vault/compiler.js");
    const compiled = await compileAgentContext("mcp-test");
    expect(compiled.content).toContain("- decision: use postgresql for storage");
  });

  it("does not double-append an identical bullet on the duplicate path", async () => {
    const { tools } = await setupAgent();
    const r1 = await tools.get("update_state")!.handler({ type: "milestone", summary: "implemented feature X" });
    const b1 = parseBody(r1);
    expect(b1.duplicate).toBeUndefined();
    expect(b1.memoryAppended).toBe(true);

    const memoryPath = getCoreFilePath("mcp-test", "MEMORY.md");
    expect((await readFile(memoryPath, "utf8")).match(/- milestone: implemented feature X/g)!.length).toBe(1);

    const r2 = await tools.get("update_state")!.handler({ type: "milestone", summary: "implemented feature X" });
    const b2 = parseBody(r2);
    expect(b2.duplicate).toBe(true);

    // The duplicate path inserts no new episode, so the prose file is untouched
    // (memoryAppended stays falsey/undefined) and the bullet still appears once.
    expect(b2.memoryAppended).toBeFalsy();
    expect((await readFile(memoryPath, "utf8")).match(/- milestone: implemented feature X/g)!.length).toBe(1);
  });

  it("writes a project-scoped bullet and keeps the global MEMORY.md untouched", async () => {
    const { tools } = await setupAgent();
    const PROJ = join(tmpdir(), "obagents-update-state-proj");
    const r = await tools.get("update_state")!.handler({ type: "build-fixed", summary: "fixed the ci pipeline", project: PROJ });
    const body = parseBody(r);
    expect(body.success).toBe(true);
    expect(body.memoryAppended).toBe(true);

    const scopedPath = getCoreFilePath("mcp-test", "MEMORY.md", PROJ);
    const scopedContent = await readFile(scopedPath, "utf8");
    expect(scopedContent).toContain("## Latest state");
    expect(scopedContent).toContain("- build-fixed: fixed the ci pipeline");

    const globalContent = await readFile(getCoreFilePath("mcp-test", "MEMORY.md"), "utf8");
    expect(globalContent).not.toContain("fixed the ci pipeline");

    const { compileAgentContext } = await import("../../src/vault/compiler.js");
    const compiled = await compileAgentContext("mcp-test", PROJ);
    expect(compiled.content).toContain("- build-fixed: fixed the ci pipeline");
  });

  it("refuses to grow MEMORY.md past the char cap instead of corrupting it", async () => {
    const { tools } = await setupAgent();
    const memoryPath = getCoreFilePath("mcp-test", "MEMORY.md");

    // Pre-fill MEMORY.md so adding the new bullet would exceed MEMORY_CHAR_LIMIT.
    await writeFile(memoryPath, "# Working Memory\n\n" + "y".repeat(2480), "utf8");

    // The bullet is skipped on the prose side (won't violate the cap) but the
    // episode still records in the FTS store, which stays the source of truth.
    const r = await tools.get("update_state")!.handler({ type: "decision", summary: "still recorded in the store" });
    const body = parseBody(r);
    expect(body.success).toBe(true);
    expect(body.memoryAppended).toBe(false);
    expect(body.memorySkipped).toBe("char-limit");

    const content = await readFile(memoryPath, "utf8");
    expect(content.length).toBeLessThanOrEqual(2500);
    expect(content).not.toContain("still recorded in the store");
    expect(listEpisodes(db, "mcp-test").some((e) => e.source === "memory" && e.content === "still recorded in the store")).toBe(true);
  });
});

describe("search_history tool", () => {
  beforeEach(async () => { await setupAgent(); });
  afterEach(teardown);

  it("proxies to FTS5 search and returns ranked episodes", async () => {
    const { tools } = await setupAgent();
    addEpisode(db, { agentName: "mcp-test", source: "consolidation", content: "discussed watermelon slicing", tags: "fruit" });
    addEpisode(db, { agentName: "mcp-test", source: "action", content: "deployed to production", tags: "ops" });

    const result = await tools.get("search_history")!.handler({ query: "watermelon" });
    const body = parseBody(result) as { results: { id: number; content: string }[] };
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0]!.content).toContain("watermelon");
  });

  it("respects the optional limit argument", async () => {
    const { tools } = await setupAgent();
    for (let i = 0; i < 5; i++) {
      addEpisode(db, { agentName: "mcp-test", source: "action", content: `production deploy ${i}` });
    }
    const result = await tools.get("search_history")!.handler({ query: "production", limit: 2 });
    const body = parseBody(result) as { results: unknown[] };
    expect(body.results.length).toBeLessThanOrEqual(2);
  });

  it("returns superseded_by field on search hits", async () => {
    const { tools } = await setupAgent();
    const ep1 = addEpisode(db, { agentName: "mcp-test", source: "memory", content: "initial architecture" });
    const ep2 = addEpisode(db, { agentName: "mcp-test", source: "memory", content: "revised architecture", supersedes: ep1.id });

    const result = await tools.get("search_history")!.handler({ query: "architecture" });
    const body = parseBody(result) as { results: { id: number; superseded_by: number | null }[] };
    const hit1 = body.results.find((h) => h.id === ep1.id);
    const hit2 = body.results.find((h) => h.id === ep2.id);

    expect(hit1?.superseded_by).toBe(ep2.id);
    expect(hit2?.superseded_by).toBeNull();
  });
});

describe("Layer-1 tool call logging", () => {
  beforeEach(async () => { await setupAgent(); });
  afterEach(teardown);

  it("skips read-only and self-documenting tools but logs mutating tools", async () => {
    const { tools } = await setupAgent();
    
    // read_state (skipped)
    await tools.get("read_state")!.handler({});
    // update_state (skipped - source: memory)
    await tools.get("update_state")!.handler({ type: "milestone", summary: "milestone entry" });

    // search_history to check tool-call episodes
    const hitsBefore = searchHistory(db, "tool=", { agentName: "mcp-test" });
    expect(hitsBefore.filter((h) => h.source === "tool-call").length).toBe(0);

    // search_history (skipped)
    await tools.get("search_history")!.handler({ query: "milestone" });

    const hitsMid = searchHistory(db, "tool=", { agentName: "mcp-test" });
    expect(hitsMid.filter((h) => h.source === "tool-call").length).toBe(0);

    // learn_skill (logged)
    await tools.get("learn_skill")!.handler({ name: "mytoolskill", protocol: "skill content" });

    const hitsAfter = searchHistory(db, "tool=learn_skill", { agentName: "mcp-test" });
    const loggedEp = hitsAfter.find((h) => h.source === "tool-call" && h.content.includes("tool=learn_skill"));
    expect(loggedEp).toBeDefined();
    expect(loggedEp?.tags).toContain("tool-call");
  });

  it("logs mutating hive actions in serving agent's episode log", async () => {
    const { tools } = await setupAgent();
    await tools.get("create_agent")!.handler({ name: "worker-one", description: "a worker agent" });

    const hits = searchHistory(db, "tool=create_agent", { agentName: "mcp-test" });
    expect(hits.some((h) => h.source === "tool-call" && h.content.includes("worker-one"))).toBe(true);

    const tmpProjPath = await mkdtemp(join(tmpdir(), "obagents-link-test-"));
    try {
      await tools.get("link_agent")!.handler({ name: "worker-one", targets: ["cursor"], projectPath: tmpProjPath });

      const linkHits = searchHistory(db, "tool=link_agent", { agentName: "mcp-test" });
      expect(linkHits.some((h) => h.source === "tool-call" && h.content.includes("tool=link_agent"))).toBe(true);
    } finally {
      await rm(tmpProjPath, { recursive: true, force: true });
    }
  });
});

describe("learn_skill tool", () => {
  beforeEach(async () => { await setupAgent(); });
  afterEach(teardown);

  it("sanitizes the skill name and writes skills/<name>/SKILL.md", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("learn_skill")!.handler({ name: "My-Skill_1", protocol: "# My Skill\nDo things." });
    const body = parseBody(result);
    expect(body).toMatchObject({ success: true });
    expect(body.path).toMatch(/skills\/my-skill_1\/SKILL\.md$/);
    const skillPath = join(getAgentDir("mcp-test"), "skills", "my-skill_1", "SKILL.md");
    expect(await exists(skillPath)).toBe(true);
    expect(await readFile(skillPath, "utf8")).toContain("Do things.");
  });

  it("rejects a skill name that sanitizes to invalid", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("learn_skill")!.handler({ name: "!!!", protocol: "x" });
    expect(result.isError).toBe(true);
    expect(NAME_PATTERN.test("!!!")).toBe(false);
  });

  it("records a skill episode in the database", async () => {
    const { tools } = await setupAgent();
    await tools.get("learn_skill")!.handler({ name: "audit", protocol: "audit skill body" });
    const hits = searchHistory(db, "audit", { agentName: "mcp-test" });
    expect(hits.some((h) => h.source === "skill" && h.content.includes("skill=audit") && h.content.includes("sha="))).toBe(true);
    const skillPath = join(getAgentDir("mcp-test"), "skills", "audit", "SKILL.md");
    expect(await readFile(skillPath, "utf8")).toBe("audit skill body");
  });

  it("records a pointer episode when learning a skill, truncating long protocols in episode content", async () => {
    const { tools } = await setupAgent();
    const longProtocol = `---\ndescription: A very long protocol description for testing truncation\n---\n` + "x".repeat(300);
    const res = await tools.get("learn_skill")!.handler({ name: "longskill", protocol: longProtocol });
    const body = parseBody(res);
    expect(body.success).toBe(true);

    const hits = searchHistory(db, "longskill", { agentName: "mcp-test" });
    const skillEpisode = hits.find((h) => h.source === "skill");
    expect(skillEpisode).toBeDefined();
    expect(skillEpisode!.content.startsWith("skill=longskill")).toBe(true);
    expect(skillEpisode!.content).toContain("sha=");
    expect(skillEpisode!.content).not.toContain(longProtocol);

    const skillPath = join(getAgentDir("mcp-test"), "skills", "longskill", "SKILL.md");
    expect(await readFile(skillPath, "utf8")).toBe(longProtocol);
  });

  it("is idempotent when called with identical name and protocol, and records new episode on modified protocol", async () => {
    const { tools } = await setupAgent();
    const name = "idempotent-skill";
    const proto1 = "# Skill\nInitial version.";

    const r1 = await tools.get("learn_skill")!.handler({ name, protocol: proto1 });
    const b1 = parseBody(r1);
    expect(b1.success).toBe(true);
    expect(b1.unchanged).toBeUndefined();

    const count1 = listEpisodes(db, "mcp-test").filter((e) => e.source === "skill").length;
    expect(count1).toBe(1);

    const r2 = await tools.get("learn_skill")!.handler({ name, protocol: proto1 });
    const b2 = parseBody(r2);
    expect(b2.success).toBe(true);
    expect(b2.unchanged).toBe(true);

    const count2 = listEpisodes(db, "mcp-test").filter((e) => e.source === "skill").length;
    expect(count2).toBe(1);

    const proto2 = "# Skill\nModified version.";
    const r3 = await tools.get("learn_skill")!.handler({ name, protocol: proto2 });
    const b3 = parseBody(r3);
    expect(b3.success).toBe(true);
    expect(b3.unchanged).toBeUndefined();

    const episodes3 = listEpisodes(db, "mcp-test").filter((e) => e.source === "skill");
    expect(episodes3.length).toBe(2);
    expect(episodes3[0]!.content).not.toEqual(episodes3[1]!.content);
  });
});

describe("read tools are side-effect-free (no project memory materialization)", () => {
  beforeEach(async () => { await setupAgent(); });
  afterEach(teardown);

  const PROJ = join(tmpdir(), "obagents-sideeffect-proj");

  it("load_agent_context never creates project memory files for an unlinked agent", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const captured = captureTools(server);
    registerTools(server, "mcp-test", { db, projectDir: PROJ });
    const tools = new Map(captured.map((t) => [t.name, t]));

    await createAgent("sideeffect-target");
    const result = await tools.get("load_agent_context")!.handler({ targetAgent: "sideeffect-target" });
    expect(result.isError).toBeFalsy();

    expect(await exists(join(getAgentDir("sideeffect-target"), "projects"))).toBe(false);
  });

  it("read_state never materializes project memory for the served project", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const captured = captureTools(server);
    registerTools(server, "mcp-test", { db, projectDir: PROJ });
    const tools = new Map(captured.map((t) => [t.name, t]));

    const result = await tools.get("read_state")!.handler({});
    expect(result.isError).toBeFalsy();

    expect(await exists(join(getAgentDir("mcp-test"), "projects"))).toBe(false);
  });

  it("load_agent_context still returns project-scoped memory for an agent whose memory was materialized on link", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const captured = captureTools(server);
    registerTools(server, "mcp-test", { db, projectDir: PROJ });
    const tools = new Map(captured.map((t) => [t.name, t]));

    await createAgent("linked-target");
    const { projectVault } = await import("../../src/vault/project.js");
    await projectVault.ensureProjectMemoryExists("linked-target", PROJ);
    const scopedPath = projectVault.getCoreFilePath("linked-target", "MEMORY.md", PROJ);
    await writeFile(scopedPath, "SCOPED TARGET MEMORY", "utf8");

    const result = await tools.get("load_agent_context")!.handler({ targetAgent: "linked-target" });
    expect(result.isError).toBeFalsy();
    const body = parseBody(result) as { memory: string };
    expect(body.memory).toContain("SCOPED TARGET MEMORY");
  });
});

describe("load_agent_context tool", () => {
  beforeEach(async () => { await setupAgent(); });
  afterEach(teardown);

  it("resolves an @-prefixed targetAgent to the bare agent name", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("load_agent_context")!.handler({ targetAgent: "@mcp-test" });
    expect(result.isError).toBeFalsy();
    const body = parseBody(result) as { memory: string };
    expect(body.memory).toContain("mcp-test");
  });

  it("still errors for a genuinely nonexistent agent (after normalization)", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("load_agent_context")!.handler({ targetAgent: "@nope-not-real" });
    expect(result.isError).toBe(true);
    const body = parseBody(result) as { error: string };
    expect(body.error).toContain("nope-not-real");
  });

  it("strips non-name characters like the CLI does (e.g. \"@mcp-test!\" -> \"mcp-test\")", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("load_agent_context")!.handler({ targetAgent: "@mcp-test!" });
    expect(result.isError).toBeFalsy();
    const body = parseBody(result) as { memory: string };
    expect(body.memory).toContain("mcp-test");
  });

  it("documents the required targetAgent argument in its description", async () => {
    const { tools } = await setupAgent();
    expect(tools.get("load_agent_context")!.description).toContain("targetAgent");
  });

  it("carries a memory-only cost note in its result", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("load_agent_context")!.handler({ targetAgent: "@mcp-test" });
    const body = parseBody(result) as { note: string };
    expect(body.note.toLowerCase()).toContain("deterministic");
  });
});

describe("consult_agent tool", () => {
  beforeEach(async () => { await setupAgent(); });
  afterEach(teardown);

  it("resolves an @-prefixed targetAgent to the bare agent name", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("consult_agent")!.handler({ targetAgent: "@mcp-test", query: "anything" });
    expect(result.isError).toBeFalsy();
  });

  it("always carries a memory-only cost note in its result", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("consult_agent")!.handler({ targetAgent: "@mcp-test", query: "anything" });
    const body = parseBody(result) as { note: string };
    expect(body.note.toLowerCase()).toContain("deterministic");
  });

  it("flags a thin result as sparse with stop-and-ask guidance", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("consult_agent")!.handler({ targetAgent: "@mcp-test", query: "zzxqq-no-such-topic" });
    const body = parseBody(result) as { sparse: boolean; guidance: string };
    expect(body.sparse).toBe(true);
    expect(body.guidance.toLowerCase()).toContain("ask");
  });

  it("documents that it is the only reliably scoped way to read another agent's memory", async () => {
    const { tools } = await setupAgent();
    expect(tools.get("consult_agent")!.description).toContain("scoped");
  });

  it("does not flag sparse when the agent has enough matching memory", async () => {
    const { tools } = await setupAgent();
    addEpisode(db, { agentName: "mcp-test", source: "memory", content: "decided to use postgres for the write model", tags: "decision" });
    addEpisode(db, { agentName: "mcp-test", source: "memory", content: "chose postgres partitioning for scale", tags: "decision" });

    const result = await tools.get("consult_agent")!.handler({ targetAgent: "@mcp-test", query: "postgres" });
    const body = parseBody(result) as { results: unknown[]; sparse?: boolean };
    expect(body.results.length).toBeGreaterThanOrEqual(2);
    expect(body.sparse).toBeFalsy();
  });

  it("flags a single weak match as sparse", async () => {
    const { tools } = await setupAgent();
    addEpisode(db, { agentName: "mcp-test", source: "memory", content: "decided to use postgres for the write model", tags: "decision" });

    const result = await tools.get("consult_agent")!.handler({ targetAgent: "@mcp-test", query: "postgres" });
    const body = parseBody(result) as { results: unknown[]; sparse?: boolean };
    expect(body.results.length).toBe(1);
    expect(body.sparse).toBe(true);
  });
});

describe("create_agent tool", () => {
  beforeEach(async () => { await setupAgent(); });
  afterEach(teardown);

  it("normalizes a leading '@' off the agent name", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("create_agent")!.handler({ name: "@created-via-at", description: "spawned from mention" });
    expect(result.isError).toBeFalsy();
    const body = parseBody(result) as { success: boolean; agent: string };
    expect(body.success).toBe(true);
    expect(body.agent).toBe("created-via-at");
    expect(agentExists("created-via-at")).toBe(true);
  });
});

describe("consolidate_agent tool", () => {
  beforeEach(async () => { await setupAgent(); });
  afterEach(teardown);

  it("normalizes a leading '@' off the agent name", async () => {
    const { tools } = await setupAgent();
    const result = await tools.get("consolidate_agent")!.handler({ name: "@mcp-test", summary: "compressed summary" });
    expect(result.isError).toBeFalsy();
    const body = parseBody(result) as { success: boolean; episodeId: number };
    expect(body.success).toBe(true);
    expect(typeof body.episodeId).toBe("number");
  });
});
