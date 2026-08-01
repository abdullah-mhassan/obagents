import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/memory/db.js";
import { executeSchema, hasFts5Support } from "../../src/memory/schema.js";
import type { Episode } from "../../src/memory/schema.js";

describe("database initialization", () => {
  const createTestDb = () => openDatabase({ agentName: "test", inMemory: true });

  it("opens an in-memory database with the episodes table", () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episodes'")
      .get() as { name: string } | undefined;
    expect(tables?.name).toBe("episodes");
    db.close();
  });

  it("creates the episodes_fts virtual table when FTS5 is available", () => {
    const db = createTestDb();
    if (!hasFts5Support(db)) {
      // FTS5 unavailable in this environment; skip the test gracefully
      db.close();
      return;
    }
    const vtables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episodes_fts'")
      .get() as { name: string } | undefined;
    expect(vtables?.name).toBe("episodes_fts");
    db.close();
  });

  it("creates indexes on agent_name, (agent_name, source), and supersedes", () => {
    const db = createTestDb();
    const indexes = db.prepare("PRAGMA index_list('episodes')").all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining([
        "idx_episodes_agent_name",
        "idx_episodes_agent_source",
        "idx_episodes_supersedes",
      ]),
    );
    db.close();
  });

  it("sets busy_timeout so concurrent writers queue instead of failing", () => {
    const db = createTestDb();
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    db.close();
  });

  it("creates the AFTER INSERT trigger", () => {
    const db = createTestDb();
    const trigger = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'episodes_ai'")
      .get() as { name: string } | undefined;
    expect(trigger?.name).toBe("episodes_ai");
    db.close();
  });

  it("creates the AFTER DELETE and AFTER UPDATE triggers", () => {
    const db = createTestDb();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as { name: string }[];
    expect(names.map((r) => r.name)).toEqual(
      expect.arrayContaining(["episodes_ad", "episodes_au", "episodes_ai"]),
    );
    db.close();
  });
});

describe("episodes + FTS5 trigger synchronization", () => {
  const createTestDb = () => openDatabase({ agentName: "test", inMemory: true });

  it("FTS index is populated automatically by triggers on INSERT", () => {
    const db = createTestDb();
    if (!hasFts5Support(db)) {
      db.close();
      return;
    }
    db.prepare(
      "INSERT INTO episodes (agent_name, source, content, tags) VALUES (?, ?, ?, ?)",
    ).run("tester", "consolidation", "the quick brown fox jumps over watermelon", "archived");
    const ftsRows = db
      .prepare("SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH 'watermelon'")
      .all() as { rowid: number }[];
    expect(ftsRows).toHaveLength(1);
    db.close();
  });

  it("FTS index entry is removed on DELETE", () => {
    const db = createTestDb();
    if (!hasFts5Support(db)) {
      db.close();
      return;
    }
    const info = db.prepare(
      "INSERT INTO episodes (agent_name, source, content, tags) VALUES (?, ?, ?, ?)",
    ).run("tester", "consolidation", "watermelon here", null) as { lastInsertRowid: number };
    db.prepare("DELETE FROM episodes WHERE id = ?").run(info.lastInsertRowid);
    const ftsRows = db
      .prepare("SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH 'watermelon'")
      .all() as { rowid: number }[];
    expect(ftsRows).toHaveLength(0);
    db.close();
  });

  it("FTS index is updated on UPDATE", () => {
    const db = createTestDb();
    if (!hasFts5Support(db)) {
      db.close();
      return;
    }
    const info = db.prepare(
      "INSERT INTO episodes (agent_name, source, content, tags) VALUES (?, ?, ?, ?)",
    ).run("tester", "consolidation", "old content", null) as { lastInsertRowid: number };
    db.prepare("UPDATE episodes SET content = ? WHERE id = ?").run("watermelon new content", info.lastInsertRowid);
    const oldRows = db
      .prepare("SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH 'old'")
      .all() as { rowid: number }[];
    const newRows = db
      .prepare("SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH 'watermelon'")
      .all() as { rowid: number }[];
    expect(oldRows).toHaveLength(0);
    expect(newRows).toHaveLength(1);
    db.close();
  });

  it("episodes row shape matches the Episode type with supersedes", () => {
    const db = createTestDb();
    const ep1 = db.prepare(
      "INSERT INTO episodes (agent_name, source, content, tags) VALUES (?, ?, ?, ?)",
    ).run("alpha", "action", "first", "a") as { lastInsertRowid: number };
    const ep2Info = db.prepare(
      "INSERT INTO episodes (agent_name, source, content, tags, supersedes) VALUES (?, ?, ?, ?, ?)",
    ).run("alpha", "action", "hello", "a,b", ep1.lastInsertRowid) as { lastInsertRowid: number };
    const row = db.prepare("SELECT * FROM episodes WHERE id = ?").get(ep2Info.lastInsertRowid) as Episode;
    expect(row.agent_name).toBe("alpha");
    expect(row.source).toBe("action");
    expect(row.content).toBe("hello");
    expect(row.tags).toBe("a,b");
    expect(row.supersedes).toBe(ep1.lastInsertRowid);
    expect(row.created_at).toBeTruthy();
    db.close();
  });

  it("migrates existing file-backed table without supersedes column automatically on openDatabase", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "obagents-db-test-"));
    const dbPath = join(tmpDir, "legacy.db");

    const legacyDb = new Database(dbPath);
    legacyDb.exec(
      "CREATE TABLE episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT NOT NULL, source TEXT NOT NULL, content TEXT NOT NULL, tags TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);",
    );
    legacyDb
      .prepare("INSERT INTO episodes (agent_name, source, content, tags) VALUES (?, ?, ?, ?)")
      .run("legacy-agent", "memory", "legacy episode content", "tag1");
    legacyDb.close();

    try {
      const db = openDatabase({ agentName: "legacy-agent", path: dbPath });

      const cols = db.prepare("PRAGMA table_info(episodes)").all() as { name: string }[];
      expect(cols.some((c) => c.name === "supersedes")).toBe(true);

      const legacyRow = db.prepare("SELECT * FROM episodes WHERE id = 1").get() as Episode;
      expect(legacyRow).toBeDefined();
      expect(legacyRow.agent_name).toBe("legacy-agent");
      expect(legacyRow.content).toBe("legacy episode content");
      expect(legacyRow.supersedes).toBeNull();

      const info = db
        .prepare(
          "INSERT INTO episodes (agent_name, source, content, tags, supersedes) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy-agent", "memory", "new episode content", "tag2", legacyRow.id) as { lastInsertRowid: number };
      const newRow = db.prepare("SELECT * FROM episodes WHERE id = ?").get(info.lastInsertRowid) as Episode;
      expect(newRow.supersedes).toBe(legacyRow.id);

      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});