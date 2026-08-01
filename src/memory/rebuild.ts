import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseType } from "./db.js";
import { openDatabase, getDbPath } from "./db.js";
import type { Episode } from "./schema.js";
import { getJsonlPath, enqueueJsonlJob } from "./jsonl.js";

export interface RebuildJsonlOptions {
  db?: DatabaseType;
}

export interface RebuildDbOptions {
  dbPath?: string;
  inMemory?: boolean;
}

/**
 * Re-writes `episodes.jsonl` from SQLite DB to ensure 100% parity. The read
 * and rewrite run as one job on the per-file mirror queue, so pending appends
 * land first and later appends resume only after the rewrite completes.
 */
export async function rebuildJsonlFromDb(
  agentName: string,
  options: RebuildJsonlOptions = {},
): Promise<number> {
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase({ agentName });

  try {
    return await enqueueJsonlJob(agentName, async () => {
      const episodes = db
        .prepare("SELECT * FROM episodes WHERE agent_name = ? ORDER BY id ASC")
        .all(agentName) as Episode[];

      const jsonlPath = getJsonlPath(agentName);
      mkdirSync(dirname(jsonlPath), { recursive: true });

      const content = episodes.map((ep) => JSON.stringify(ep)).join("\n") + (episodes.length > 0 ? "\n" : "");
      writeFileSync(jsonlPath, content, "utf8");

      return episodes.length;
    });
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

/**
 * Re-creates SQLite DB from `episodes.jsonl`.
 */
export function rebuildDbFromJsonl(
  agentName: string,
  options: RebuildDbOptions = {},
): number {
  const jsonlPath = getJsonlPath(agentName);
  const episodes: Episode[] = [];

  if (existsSync(jsonlPath)) {
    const fileContent = readFileSync(jsonlPath, "utf8");
    const lines = fileContent.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Episode;
        if (parsed && typeof parsed.id === "number") {
          episodes.push(parsed);
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  const dbPath = options.dbPath ?? (options.inMemory ? ":memory:" : getDbPath(agentName));
  const db = openDatabase({ agentName, path: dbPath, inMemory: options.inMemory });

  try {
    const rebuildTx = db.transaction((list: Episode[]) => {
      db.prepare("DELETE FROM episodes").run();

      const insertStmt = db.prepare(
        `INSERT INTO episodes (id, agent_name, source, content, tags, supersedes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const ep of list) {
        insertStmt.run(
          ep.id,
          ep.agent_name || agentName,
          ep.source,
          ep.content,
          ep.tags ?? null,
          ep.supersedes ?? null,
          ep.created_at,
        );
      }
    });

    rebuildTx(episodes);
    return episodes.length;
  } finally {
    db.close();
  }
}
