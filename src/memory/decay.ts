import type { DatabaseType } from "./db.js";
import { openDatabase } from "./db.js";
import { DEFAULT_TOOL_CALL_RETENTION_DAYS } from "../utils/constants.js";
import { rebuildJsonlFromDb } from "./rebuild.js";

export interface PruneOptions {
  db?: DatabaseType;
  days?: number;
  dryRun?: boolean;
}

export interface PruneResult {
  prunedToolCalls: number;
  prunedSuperseded: number;
  totalPruned: number;
}

export async function pruneStaleEpisodes(
  agentName: string,
  options: PruneOptions = {},
): Promise<PruneResult> {
  const days = options.days ?? DEFAULT_TOOL_CALL_RETENTION_DAYS;
  const dryRun = options.dryRun ?? false;

  const ownsDb = !options.db;
  const db = options.db ?? openDatabase({ agentName });

  try {
    // 1. Identify stale tool-call episodes older than retention period
    const staleToolCalls = db
      .prepare(
        `SELECT id FROM episodes
         WHERE agent_name = ?
           AND source IN ('tool-call', 'action')
           AND created_at < datetime('now', '-' || ? || ' days')`,
      )
      .all(agentName, days) as { id: number }[];

    // 2. Identify superseded episodes covered by a consolidation episode
    const supersededEpisodes = db
      .prepare(
        `SELECT e.id FROM episodes e
         WHERE e.agent_name = ?
           AND e.source NOT IN ('consolidation', 'skill')
           AND e.id IN (SELECT supersedes FROM episodes WHERE agent_name = ? AND supersedes IS NOT NULL)
           AND EXISTS (
             SELECT 1 FROM episodes c
             JOIN episodes repl ON repl.supersedes = e.id AND repl.agent_name = e.agent_name
             WHERE c.agent_name = e.agent_name
               AND c.source = 'consolidation'
               AND (c.id > repl.id OR c.created_at >= repl.created_at)
           )`,
      )
      .all(agentName, agentName) as { id: number }[];

    const prunedToolCalls = staleToolCalls.length;
    const prunedSuperseded = supersededEpisodes.length;
    const totalPruned = prunedToolCalls + prunedSuperseded;

    if (!dryRun && totalPruned > 0) {
      const idsToDelete = [
        ...staleToolCalls.map((r) => r.id),
        ...supersededEpisodes.map((r) => r.id),
      ];

      const deleteTx = db.transaction((ids: number[]) => {
        const clearFkStmt = db.prepare("UPDATE episodes SET supersedes = NULL WHERE supersedes = ?");
        const stmt = db.prepare("DELETE FROM episodes WHERE id = ?");
        for (const id of ids) {
          clearFkStmt.run(id);
          stmt.run(id);
        }
      });

      deleteTx(idsToDelete);

      // Keep episodes.jsonl mirror in sync if not in-memory DB
      if (db.name !== ":memory:" && db.name !== "") {
        await rebuildJsonlFromDb(agentName, { db });
      }
    }

    return {
      prunedToolCalls,
      prunedSuperseded,
      totalPruned,
    };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}
