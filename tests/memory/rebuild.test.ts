import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { createAgent } from "../../src/vault/agent.js";
import { openDatabase, getDbPath } from "../../src/memory/db.js";
import { addEpisode } from "../../src/memory/fts.js";
import { rebuildJsonlFromDb, rebuildDbFromJsonl } from "../../src/memory/rebuild.js";
import { getJsonlPath, appendEpisodeToJsonl } from "../../src/memory/jsonl.js";
import type { Episode } from "../../src/memory/schema.js";

describe("Disaster Recovery (rebuild.ts)", () => {
  let tmpDir: string;
  const agentName = "recovery-agent";

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "obagents-rebuild-test-"));
    overrideVaultRoot(tmpDir);
    await createAgent(agentName);
  });

  afterEach(() => {
    overrideVaultRoot(null);
    // better-sqlite3's WAL mode leaves -wal/-shm sidecar files whose OS-level
    // cleanup can lag slightly behind db.close() (this file's second test opens
    // and closes two real-file connections to the same path, which doubles the
    // chance of catching that lag). maxRetries/retryDelay is Node's built-in
    // handling for exactly this class of transient ENOTEMPTY/EBUSY race.
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("rebuilds episodes.jsonl from state.db", async () => {
    const dbPath = getDbPath(agentName);
    const db = openDatabase({ agentName, path: dbPath });

    try {
      const ep1 = addEpisode(db, { agentName, source: "memory", content: "First entry", tags: ["v1"] });
      const ep2 = addEpisode(db, { agentName, source: "skill", content: "Learned skill", tags: ["skill"] });
      const ep3 = addEpisode(db, {
        agentName,
        source: "memory",
        content: "Second entry",
        supersedes: ep1.id,
      });

      const count = await rebuildJsonlFromDb(agentName, { db });
      expect(count).toBe(3);

      const jsonlPath = getJsonlPath(agentName);
      expect(existsSync(jsonlPath)).toBe(true);

      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(3);

      const parsedEp1 = JSON.parse(lines[0]!) as Episode;
      expect(parsedEp1.id).toBe(ep1.id);
      expect(parsedEp1.content).toBe("First entry");

      const parsedEp3 = JSON.parse(lines[2]!) as Episode;
      expect(parsedEp3.supersedes).toBe(ep1.id);
    } finally {
      db.close();
    }
  });

  it("rebuilds state.db from episodes.jsonl", async () => {
    const dbPath = getDbPath(agentName);
    const db = openDatabase({ agentName, path: dbPath });

    addEpisode(db, { agentName, source: "memory", content: "Original entry 1" });
    addEpisode(db, { agentName, source: "tool-call", content: "Tool call 2" });
    await rebuildJsonlFromDb(agentName, { db });
    db.close();

    // Rebuild DB in memory from JSONL
    const count = rebuildDbFromJsonl(agentName, { dbPath, inMemory: true });
    expect(count).toBe(2);

    const testDb = openDatabase({ agentName, path: dbPath });
    try {
      const rows = testDb.prepare("SELECT * FROM episodes ORDER BY id ASC").all() as Episode[];
      expect(rows).toHaveLength(2);
      expect(rows[0]!.content).toBe("Original entry 1");
      expect(rows[1]!.content).toBe("Tool call 2");
    } finally {
      testDb.close();
    }
  });

  it("maintains bidirectional round-trip parity between state.db and episodes.jsonl", async () => {
    const dbPath = getDbPath(agentName);
    const db = openDatabase({ agentName, path: dbPath });

    try {
      addEpisode(db, { agentName, source: "memory", content: "Alpha memory", tags: ["tagA"] });
      addEpisode(db, { agentName, source: "consolidation", content: "Beta summary" });
      await rebuildJsonlFromDb(agentName, { db });
    } finally {
      db.close();
    }

    // Rebuild DB from JSONL
    rebuildDbFromJsonl(agentName, { dbPath });

    // Verify DB state matches
    const newDb = openDatabase({ agentName, path: dbPath });
    try {
      const rows = newDb.prepare("SELECT * FROM episodes ORDER BY id ASC").all() as Episode[];
      expect(rows).toHaveLength(2);
      expect(rows[0]!.content).toBe("Alpha memory");
      expect(rows[1]!.content).toBe("Beta summary");
    } finally {
      newDb.close();
    }
  });

  it("rebuild after a pending append never duplicates episode lines", async () => {
    const dbPath = getDbPath(agentName);
    const db = openDatabase({ agentName, path: dbPath });

    try {
      const ep = addEpisode(db, { agentName, source: "memory", content: "Pending episode" });
      const row = db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep.id) as Episode;
      const pendingAppend = appendEpisodeToJsonl(agentName, row);

      const count = await rebuildJsonlFromDb(agentName, { db });
      expect(count).toBe(1);

      const jsonlPath = getJsonlPath(agentName);
      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0]!) as Episode).id).toBe(ep.id);

      await pendingAppend;

      const linesAfter = readFileSync(jsonlPath, "utf8").trim().split("\n").filter((l) => l.length > 0);
      expect(linesAfter).toHaveLength(1);

      const restored = rebuildDbFromJsonl(agentName, { dbPath, inMemory: true });
      expect(restored).toBe(1);
    } finally {
      db.close();
    }
  });
});
