import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/cleanup-memory.mjs");

function createTestDb(dbPath: string, agentName: string) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      supersedes INTEGER REFERENCES episodes(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      agent_name UNINDEXED,
      content,
      tags,
      content='episodes',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, agent_name, content, tags)
      VALUES (new.id, new.agent_name, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, agent_name, content, tags)
      VALUES('delete', old.id, old.agent_name, old.content, old.tags);
    END;
  `);

  const insert = db.prepare(`
    INSERT INTO episodes (agent_name, source, content, tags, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  // 1. Exact duplicates (IDs 1, 2, 3)
  insert.run(agentName, "user", "Exact duplicate content", "tag1", "2026-01-01");
  insert.run(agentName, "user", "Exact duplicate content", "tag1", "2026-01-02");
  insert.run(agentName, "user", "Exact duplicate content", "tag1", "2026-01-03");

  // 2. Dump episode (ID 4)
  insert.run(agentName, "skill", "import foo from 'bar';\nconsole.log(foo);", "dump", "2026-01-04");

  // 3. Legit skill episode (ID 5)
  insert.run(agentName, "skill", "---\nname: my-skill\n---\nSkill body", "good", "2026-01-05");

  // 4. Unique regular episode (ID 6)
  insert.run(agentName, "system", "Unique system event", "sys", "2026-01-06");

  db.close();
}

describe("scripts/cleanup-memory.mjs", () => {
  let tempVault: string;

  beforeEach(() => {
    tempVault = mkdtempSync(join(tmpdir(), "obagents-clean-test-"));
    const agent1Dir = join(tempVault, "agents", "agent1");
    const agent2Dir = join(tempVault, "agents", "agent2");
    mkdirSync(agent1Dir, { recursive: true });
    mkdirSync(agent2Dir, { recursive: true });

    createTestDb(join(agent1Dir, "state.db"), "agent1");
    createTestDb(join(agent2Dir, "state.db"), "agent2");

    // Setup junk skill file in agent1
    const junkSkillDir = join(agent1Dir, "skills", "junk-skill");
    mkdirSync(junkSkillDir, { recursive: true });
    writeFileSync(join(junkSkillDir, "SKILL.md"), "NO FRONTMATTER HERE\nimport x from 'y';");

    // Setup legit skill file in agent1
    const legitSkillDir = join(agent1Dir, "skills", "legit-skill");
    mkdirSync(legitSkillDir, { recursive: true });
    writeFileSync(join(legitSkillDir, "SKILL.md"), "---\nname: legit-skill\n---\nHello");
  });

  afterEach(() => {
    if (existsSync(tempVault)) {
      rmSync(tempVault, { recursive: true, force: true });
    }
  });

  it("performs dry-run by default and deletes nothing", () => {
    const stdout = execFileSync(process.execPath, [scriptPath, "--vault", tempVault], {
      encoding: "utf8",
    });

    expect(stdout).toContain("DRY-RUN");
    expect(stdout).toContain("junk skill file candidates (NOT deleted)");
    expect(stdout).toContain("junk-skill");

    // Verify DB still has all 6 episodes
    const db1 = new Database(join(tempVault, "agents", "agent1", "state.db"), { readonly: true });
    const count1 = db1.prepare("SELECT COUNT(*) as count FROM episodes").get() as { count: number };
    expect(count1.count).toBe(6);
    db1.close();
  });

  it("deletes duplicates and dump episodes under --apply while keeping legit skill, oldest dup, and junk skill file", () => {
    const stdout = execFileSync(process.execPath, [scriptPath, "--vault", tempVault, "--apply"], {
      encoding: "utf8",
    });

    expect(stdout).toContain("APPLY");
    expect(stdout).toContain("junk skill file candidates (NOT deleted)");
    expect(stdout).toContain("junk-skill");

    // Verify DB in agent1
    const db1 = new Database(join(tempVault, "agents", "agent1", "state.db"), { readonly: true });
    const rows = db1.prepare("SELECT id, source, content FROM episodes ORDER BY id ASC").all() as {
      id: number;
      source: string;
      content: string;
    }[];
    db1.close();

    // Originally 6 rows:
    // ID 1: dup (kept)
    // ID 2: dup (deleted)
    // ID 3: dup (deleted)
    // ID 4: dump (deleted)
    // ID 5: legit skill (kept)
    // ID 6: unique system (kept)
    expect(rows.map((r) => r.id)).toEqual([1, 5, 6]);

    // Check that ID 1 content is kept
    expect(rows.find((r) => r.id === 1)?.content).toBe("Exact duplicate content");
    // Check that ID 5 is kept
    expect(rows.find((r) => r.id === 5)?.content).toContain("name: my-skill");

    // Assert (c): junk skill file still exists on disk
    const junkSkillFilePath = join(tempVault, "agents", "agent1", "skills", "junk-skill", "SKILL.md");
    expect(existsSync(junkSkillFilePath)).toBe(true);
  });
});
