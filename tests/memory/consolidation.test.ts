import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { overrideVaultRoot, getAgentDir } from "../../src/utils/paths.js";
import { getCoreFilePath } from "../../src/vault/project.js";
import { createAgent } from "../../src/vault/agent.js";
import { openDatabase } from "../../src/memory/db.js";
import { checkMemoryOverflow, consolidateMemory } from "../../src/memory/consolidation.js";
import { MEMORY_CHAR_LIMIT } from "../../src/utils/constants.js";
import type { DatabaseType } from "../../src/memory/db.js";

let tmpRoot: string;
let db: DatabaseType;

async function freshSetup(): Promise<void> {
  tmpRoot = await mkdtemp(join(tmpdir(), "obagents-cons-"));
  overrideVaultRoot(tmpRoot);
  db = openDatabase({ agentName: "test", inMemory: true });
  await createAgent("tester");
}

async function teardown(): Promise<void> {
  if (db) db.close();
  overrideVaultRoot(null);
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
}

const LONG_MEMORY = "watermelon " + "x".repeat(MEMORY_CHAR_LIMIT + 10);

describe("checkMemoryOverflow", () => {
  beforeEach(freshSetup);
  afterEach(teardown);

  it("returns false when the agent has no memory entries", async () => {
    expect(await checkMemoryOverflow("tester")).toBe(false);
  });

  it("returns true once the structured-store row threshold is reached", async () => {
    const testerDb = openDatabase({ agentName: "tester" });
    for (let i = 0; i < 20; i++) {
      testerDb
        .prepare(
          "INSERT INTO episodes (agent_name, source, content, tags) VALUES (?, 'memory', ?, ?)",
        )
        .run("tester", `distinct memory entry ${i}`, "milestone,__global__");
    }
    testerDb.close();
    expect(await checkMemoryOverflow("tester")).toBe(true);
  });

  it("respects project scope when checking memory overflow", async () => {
    const projectDir = join(tmpRoot, "project-1");
    await mkdir(projectDir);
    const testerDb = openDatabase({ agentName: "tester" });
    for (let i = 0; i < 20; i++) {
      testerDb
        .prepare(
          "INSERT INTO episodes (agent_name, source, content, tags) VALUES (?, 'memory', ?, ?)",
        )
        .run("tester", `distinct memory entry ${i}`, "milestone,__global__");
    }
    testerDb.close();
    expect(await checkMemoryOverflow("tester")).toBe(true); // Global is true
    expect(await checkMemoryOverflow("tester", projectDir)).toBe(false); // Project is false
  });

  it("throws on missing agent", async () => {
    await expect(checkMemoryOverflow("ghost")).rejects.toThrow(/does not exist/);
  });
});

describe("consolidateMemory", () => {
  beforeEach(freshSetup);
  afterEach(teardown);

  it("archives the current MEMORY.md to an episode and replaces it with the summary", async () => {
    const memoryPath = join(getAgentDir("tester"), "MEMORY.md");
    await writeFile(memoryPath, LONG_MEMORY, "utf8");

    const outcome = await consolidateMemory("tester", "Consolidated testing memory.", { db });

    const after = await readFile(memoryPath, "utf8");
    expect(after.trim()).toBe("Consolidated testing memory.");

    const rows = db
      .prepare("SELECT id, source, content FROM episodes WHERE agent_name = ?")
      .all("tester") as { id: number; source: string; content: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("consolidation");
    expect(rows[0]!.content).toBe(LONG_MEMORY);
    expect(outcome.archivedContent).toBe(LONG_MEMORY);
    expect(outcome.summaryContent).toBe("Consolidated testing memory.");
  });

  it("archives project-scoped memory to an episode and tags it with project context", async () => {
    const projectDir = join(tmpRoot, "project-1");
    await mkdir(projectDir, { recursive: true });
    const memoryPath = getCoreFilePath("tester", "MEMORY.md", projectDir);
    await mkdir(dirname(memoryPath), { recursive: true });
    await writeFile(memoryPath, LONG_MEMORY, "utf8");

    const outcome = await consolidateMemory("tester", "Consolidated project memory.", { db, projectDir });

    const after = await readFile(memoryPath, "utf8");
    expect(after.trim()).toBe("Consolidated project memory.");

    const rows = db
      .prepare("SELECT id, source, content, tags FROM episodes WHERE agent_name = ? AND source = 'consolidation'")
      .all("tester") as { id: number; source: string; content: string; tags: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe(LONG_MEMORY);
    expect(rows[0]!.tags).toContain(projectDir);
    
    // Global memory should be untouched
    const globalPath = join(getAgentDir("tester"), "MEMORY.md");
    expect(existsSync(globalPath)).toBe(true);
    const globalContent = await readFile(globalPath, "utf8");
    expect(globalContent).not.toContain("Consolidated project memory.");
  });

  it("throws when the summary exceeds the limit", async () => {
    const memoryPath = join(getAgentDir("tester"), "MEMORY.md");
    await writeFile(memoryPath, "x".repeat(MEMORY_CHAR_LIMIT + 10), "utf8");
    const oversizeSummary = "y".repeat(MEMORY_CHAR_LIMIT + 1);
    await expect(
      consolidateMemory("tester", oversizeSummary, { db }),
    ).rejects.toThrow(/summary.*exceeds/i);
    const after = await readFile(memoryPath, "utf8");
    expect(after).not.toBe(oversizeSummary);
  });

  it("persists the episode to a real on-disk database when no db is passed", async () => {
    db.close();
    const memoryPath = join(getAgentDir("tester"), "MEMORY.md");
    await writeFile(memoryPath, LONG_MEMORY, "utf8");
    const outcome = await consolidateMemory("tester", "short summary");
    expect(existsSync(join(getAgentDir("tester"), "state.db"))).toBe(true);
    expect(outcome.archivedContent).toBe(LONG_MEMORY);
    const Database = (await import("better-sqlite3")).default;
    const diskDb = new Database(join(getAgentDir("tester"), "state.db"));
    const rows = diskDb.prepare("SELECT content FROM episodes WHERE agent_name = ?").all("tester") as { content: string }[];
    diskDb.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe(LONG_MEMORY);
  });

  it("is idempotent: consolidating again archives the summary as a new episode", async () => {
    const memoryPath = join(getAgentDir("tester"), "MEMORY.md");
    await writeFile(memoryPath, LONG_MEMORY, "utf8");
    await consolidateMemory("tester", "first summary", { db });
    await consolidateMemory("tester", "second summary", { db });
    const rows = db
      .prepare("SELECT content FROM episodes WHERE agent_name = ? ORDER BY id")
      .all("tester") as { content: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content).toBe(LONG_MEMORY);
    expect(rows[1]!.content).toBe("first summary\n");
    const after = await readFile(memoryPath, "utf8");
    expect(after.trim()).toBe("second summary");
  });

  it("throws on missing agent", async () => {
    await expect(consolidateMemory("ghost", "summary", { db })).rejects.toThrow(/does not exist/);
  });

  it("archives optional tags when provided", async () => {
    await writeFile(join(getAgentDir("tester"), "MEMORY.md"), "some old memory", "utf8");
    await consolidateMemory("tester", "new", { db, tags: "archive,manual" });
    const row = db
      .prepare("SELECT tags FROM episodes WHERE agent_name = ?")
      .get("tester") as { tags: string | null };
    expect(row.tags).toBe("archive,manual");
  });
});
