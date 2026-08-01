export const DB_FILE_NAME = "state.db";

export interface Episode {
  id: number;
  agent_name: string;
  source: string;
  content: string;
  tags: string | null;
  supersedes: number | null;
  created_at: string;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  supersedes INTEGER REFERENCES episodes(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_episodes_agent_name ON episodes (agent_name);
CREATE INDEX IF NOT EXISTS idx_episodes_agent_source ON episodes (agent_name, source);

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

CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, agent_name, content, tags)
  VALUES('delete', old.id, old.agent_name, old.content, old.tags);
  INSERT INTO episodes_fts(rowid, agent_name, content, tags)
  VALUES (new.id, new.agent_name, new.content, new.tags);
END;
`;

import type { Database as DatabaseType } from "better-sqlite3";

function migrateEpisodesTable(db: DatabaseType): void {
  const cols = db.prepare("PRAGMA table_info(episodes)").all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "supersedes")) {
    db.exec("ALTER TABLE episodes ADD COLUMN supersedes INTEGER REFERENCES episodes(id)");
  }
}

export function executeSchema(db: DatabaseType): void {
  db.exec(SCHEMA_SQL);
  migrateEpisodesTable(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_supersedes ON episodes (supersedes)");
  if (!hasFts5Support(db)) {
    throw new Error("SQLite install lacks FTS5 support required by the Deep Memory Engine.");
  }
}

export function hasFts5Support(db: DatabaseType): boolean {
  const row = db.prepare(
    "SELECT 1 FROM pragma_module_list() WHERE name = ?",
  ).get("fts5") as { "1": number } | undefined;
  return Boolean(row);
}