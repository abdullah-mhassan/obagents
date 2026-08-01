import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { createAgent } from "../../src/vault/agent.js";
import { openDatabase, getDbPath } from "../../src/memory/db.js";
import { addEpisode } from "../../src/memory/fts.js";
import { createMemoryCommand } from "../../src/commands/memory.ts";
import { rebuildJsonlFromDb } from "../../src/memory/rebuild.js";
import { getJsonlPath } from "../../src/memory/jsonl.js";

describe("CLI Commands: memory", () => {
  let tmpDir: string;
  const agentName = "mem-cmd-agent";

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "obagents-cmd-test-"));
    overrideVaultRoot(tmpDir);
    await createAgent(agentName);
  });

  afterEach(() => {
    overrideVaultRoot(null);
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("obagents memory prune --dry-run previews pruning count", async () => {
    const dbPath = getDbPath(agentName);
    const db = openDatabase({ agentName, path: dbPath });

    db.prepare(
      "INSERT INTO episodes (agent_name, source, content, created_at) VALUES (?, ?, ?, datetime('now', '-45 days'))",
    ).run(agentName, "tool-call", "stale tool call for CLI test");
    db.close();

    const cmd = createMemoryCommand();
    cmd.exitOverride(); // Prevent process.exit in tests

    await cmd.parseAsync(["node", "obagents", "prune", agentName, "--days", "30", "--dry-run"]);

    // Verify DB still contains the stale episode
    const testDb = openDatabase({ agentName, path: dbPath });
    try {
      const count = (testDb.prepare("SELECT COUNT(*) as n FROM episodes").get() as { n: number }).n;
      expect(count).toBe(1);
    } finally {
      testDb.close();
    }
  });

  it("obagents memory prune executes pruning", async () => {
    const dbPath = getDbPath(agentName);
    const db = openDatabase({ agentName, path: dbPath });

    db.prepare(
      "INSERT INTO episodes (agent_name, source, content, created_at) VALUES (?, ?, ?, datetime('now', '-45 days'))",
    ).run(agentName, "tool-call", "stale tool call to delete");
    db.close();

    const cmd = createMemoryCommand();
    cmd.exitOverride();

    await cmd.parseAsync(["node", "obagents", "prune", agentName, "--days", "30"]);

    const testDb = openDatabase({ agentName, path: dbPath });
    try {
      const count = (testDb.prepare("SELECT COUNT(*) as n FROM episodes").get() as { n: number }).n;
      expect(count).toBe(0);
    } finally {
      testDb.close();
    }
  });

  it("obagents memory rebuild-jsonl rebuilds the jsonl mirror", async () => {
    const dbPath = getDbPath(agentName);
    const db = openDatabase({ agentName, path: dbPath });
    addEpisode(db, { agentName, source: "memory", content: "Test memory" });
    db.close();

    const cmd = createMemoryCommand();
    cmd.exitOverride();

    await cmd.parseAsync(["node", "obagents", "rebuild-jsonl", agentName]);

    const jsonlPath = getJsonlPath(agentName);
    expect(existsSync(jsonlPath)).toBe(true);
  });

  it("obagents memory rebuild-db restores state.db from jsonl", async () => {
    const dbPath = getDbPath(agentName);
    const db = openDatabase({ agentName, path: dbPath });
    addEpisode(db, { agentName, source: "memory", content: "Memory to backup" });
    await rebuildJsonlFromDb(agentName, { db });
    // Clear DB
    db.prepare("DELETE FROM episodes").run();
    db.close();

    const cmd = createMemoryCommand();
    cmd.exitOverride();

    await cmd.parseAsync(["node", "obagents", "rebuild-db", agentName]);

    const testDb = openDatabase({ agentName, path: dbPath });
    try {
      const count = (testDb.prepare("SELECT COUNT(*) as n FROM episodes").get() as { n: number }).n;
      expect(count).toBe(1);
    } finally {
      testDb.close();
    }
  });

  it("obagents memory tree outputs formatted markdown memory tree", async () => {
    const dbPath = getDbPath(agentName);
    const db = openDatabase({ agentName, path: dbPath });
    addEpisode(db, { agentName, source: "skill", content: "TypeScript pattern" });
    db.close();

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const cmd = createMemoryCommand();
    cmd.exitOverride();

    await cmd.parseAsync(["node", "obagents", "tree", agentName, "-g"]);

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain(`# Memory Tree: ${agentName}`);
    expect(output).toContain("TypeScript pattern");
  });
});
