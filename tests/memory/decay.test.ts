import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/memory/db.js";
import { pruneStaleEpisodes } from "../../src/memory/decay.js";
import { addEpisode } from "../../src/memory/fts.js";
import { consolidateMemory } from "../../src/memory/consolidation.js";
import { createAgent } from "../../src/vault/agent.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseType } from "../../src/memory/db.js";

describe("pruneStaleEpisodes (Memory Decay)", () => {
  let db: DatabaseType;
  const agentName = "test-agent";

  beforeEach(() => {
    db = openDatabase({ agentName, inMemory: true });
  });

  afterEach(() => {
    if (db) db.close();
  });

  it("prunes tool-call episodes older than retention days while leaving recent tool-calls", async () => {
    // Insert an old tool-call episode (60 days old)
    db.prepare(
      "INSERT INTO episodes (agent_name, source, content, created_at) VALUES (?, ?, ?, datetime('now', '-60 days'))",
    ).run(agentName, "tool-call", "old tool call 1");

    // Insert a recent tool-call episode (5 days old)
    db.prepare(
      "INSERT INTO episodes (agent_name, source, content, created_at) VALUES (?, ?, ?, datetime('now', '-5 days'))",
    ).run(agentName, "tool-call", "recent tool call 2");

    // Insert active memory episode
    addEpisode(db, { agentName, source: "memory", content: "Important decision" });

    const result = await pruneStaleEpisodes(agentName, { db, days: 30 });
    expect(result.prunedToolCalls).toBe(1);
    expect(result.prunedSuperseded).toBe(0);
    expect(result.totalPruned).toBe(1);

    const remaining = db.prepare("SELECT content FROM episodes").all() as { content: string }[];
    expect(remaining.map((r) => r.content)).not.toContain("old tool call 1");
    expect(remaining.map((r) => r.content)).toContain("recent tool call 2");
    expect(remaining.map((r) => r.content)).toContain("Important decision");
  });

  it("prunes superseded memory entries only after consolidation occurs", async () => {
    // Ep 1: Active memory
    const ep1 = addEpisode(db, { agentName, source: "memory", content: "Original key decision" });
    // Ep 2: Supersedes Ep 1
    const ep2 = addEpisode(db, {
      agentName,
      source: "memory",
      content: "Updated key decision",
      supersedes: ep1.id,
    });

    // Before consolidation, ep1 should NOT be pruned
    const beforeResult = await pruneStaleEpisodes(agentName, { db });
    expect(beforeResult.prunedSuperseded).toBe(0);

    // Ep 3: Consolidation episode created after ep2
    addEpisode(db, { agentName, source: "consolidation", content: "Summary of memory" });

    // After consolidation, ep1 SHOULD be pruned
    const afterResult = await pruneStaleEpisodes(agentName, { db });
    expect(afterResult.prunedSuperseded).toBe(1);

    const remainingIds = (db.prepare("SELECT id FROM episodes").all() as { id: number }[]).map(
      (r) => r.id,
    );
    expect(remainingIds).not.toContain(ep1.id);
    expect(remainingIds).toContain(ep2.id);
  });

  it("respects dryRun option without modifying database", async () => {
    db.prepare(
      "INSERT INTO episodes (agent_name, source, content, created_at) VALUES (?, ?, ?, datetime('now', '-40 days'))",
    ).run(agentName, "tool-call", "stale action");

    const result = await pruneStaleEpisodes(agentName, { db, days: 30, dryRun: true });
    expect(result.prunedToolCalls).toBe(1);
    expect(result.totalPruned).toBe(1);

    const remaining = db.prepare("SELECT COUNT(*) as n FROM episodes").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("never auto-deletes active memory, consolidation, or skill episodes", async () => {
    db.prepare(
      "INSERT INTO episodes (agent_name, source, content, created_at) VALUES (?, ?, ?, datetime('now', '-100 days'))",
    ).run(agentName, "memory", "Old active memory");
    db.prepare(
      "INSERT INTO episodes (agent_name, source, content, created_at) VALUES (?, ?, ?, datetime('now', '-100 days'))",
    ).run(agentName, "consolidation", "Old consolidation summary");
    db.prepare(
      "INSERT INTO episodes (agent_name, source, content, created_at) VALUES (?, ?, ?, datetime('now', '-100 days'))",
    ).run(agentName, "skill", "Old skill receipt");

    const result = await pruneStaleEpisodes(agentName, { db, days: 30 });
    expect(result.totalPruned).toBe(0);

    const count = (db.prepare("SELECT COUNT(*) as n FROM episodes").get() as { n: number }).n;
    expect(count).toBe(3);
  });
});

describe("consolidateMemory auto-pruning integration", () => {
  let tmpDir: string;
  const agentName = "auto-prune-agent";

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "obagents-decay-test-"));
    overrideVaultRoot(tmpDir);
    await createAgent(agentName);
  });

  afterEach(() => {
    overrideVaultRoot(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("automatically prunes stale tool-calls during consolidation", async () => {
    const db = openDatabase({ agentName });
    try {
      db.prepare(
        "INSERT INTO episodes (agent_name, source, content, created_at) VALUES (?, ?, ?, datetime('now', '-60 days'))",
      ).run(agentName, "tool-call", "stale tool call to auto prune");

      await consolidateMemory(agentName, "Consolidation summary", { db });

      const staleCount = (
        db
          .prepare(
            "SELECT COUNT(*) as n FROM episodes WHERE source = 'tool-call' AND content = 'stale tool call to auto prune'",
          )
          .get() as { n: number }
      ).n;
      expect(staleCount).toBe(0);
    } finally {
      db.close();
    }
  });
});
