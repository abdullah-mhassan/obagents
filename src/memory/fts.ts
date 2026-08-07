import type { DatabaseType } from "./db.js";
import type { Episode } from "./schema.js";
import { projectMatchClause } from "./project-tag.js";
import {
  NEAR_DUPLICATE_JACCARD_THRESHOLD,
  CONSOLIDATION_TRIGGER_THRESHOLD,
  CONSOLIDATION_DEDUP_TRIGGER,
} from "../utils/constants.js";
import { appendEpisodeToJsonl } from "./jsonl.js";
import { logger } from "../utils/logger.js";

export type EpisodeSource = "consolidation" | "skill" | "action" | string;

export interface AddEpisodeInput {
  agentName: string;
  source: EpisodeSource;
  content: string;
  tags?: string | string[] | null;
  supersedes?: number | null;
}

export interface SearchHit extends Episode {
  rank: number;
  superseded_by: number | null;
}

function normalizeTags(tags?: string | string[] | null): string | null {
  if (tags == null) return null;
  if (typeof tags === "string") return tags.length === 0 ? null : tags;
  const joined = tags.join(",");
  return joined.length === 0 ? null : joined;
}

export function addEpisode(db: DatabaseType, input: AddEpisodeInput): Episode {
  const tags = normalizeTags(input.tags);
  const info = db
    .prepare(
      "INSERT INTO episodes (agent_name, source, content, tags, supersedes) VALUES (?, ?, ?, ?, ?)",
    )
    .run(input.agentName, input.source, input.content, tags, input.supersedes ?? null) as {
    lastInsertRowid: number;
  };
  const row = db
    .prepare("SELECT * FROM episodes WHERE id = ?")
    .get(info.lastInsertRowid) as Episode;
  mirrorEpisode(db, input.agentName, row);
  return row;
}

function mirrorEpisode(db: DatabaseType, agentName: string, row: Episode): void {
  if (db.name === ":memory:") return;
  try {
    appendEpisodeToJsonl(agentName, row);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warning(`episodes.jsonl mirror failed for agent "${agentName}": ${msg}`);
  }
}

export function getEpisode(db: DatabaseType, id: number): Episode | undefined {
  return db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as
    | Episode
    | undefined;
}

export function findMemoryEpisodeByContent(
  db: DatabaseType,
  agentName: string,
  content: string,
  project?: string,
  type?: string,
): Episode | undefined {
  const { clause: projectClause, params: projectParams } = projectMatchClause(project, "e");
  let typeClause = "";
  const typeParams: string[] = [];
  if (type) {
    typeClause = "AND (e.tags = ? OR e.tags LIKE ? OR e.tags LIKE ? OR e.tags LIKE ?)";
    typeParams.push(type, `${type},%`, `%,${type}`, `%,${type},%`);
  }
  return db
    .prepare(
      `SELECT e.* FROM episodes e WHERE e.agent_name = ? AND e.source = 'memory' AND e.content = ? AND NOT EXISTS (SELECT 1 FROM episodes s WHERE s.supersedes = e.id) ${typeClause} ${projectClause} ORDER BY e.id DESC LIMIT 1`,
    )
    .get(agentName, content, ...typeParams, ...projectParams) as Episode | undefined;
}

export function listEpisodes(
  db: DatabaseType,
  agentName?: string,
  limit = 100,
): Episode[] {
  if (agentName) {
    return db
      .prepare("SELECT * FROM episodes WHERE agent_name = ? ORDER BY id DESC LIMIT ?")
      .all(agentName, limit) as Episode[];
  }
  return db
    .prepare("SELECT * FROM episodes ORDER BY id DESC LIMIT ?")
    .all(limit) as Episode[];
}

function sanitizeFtsQuery(query: string): string {
  const tokens = query.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export interface SearchOptions {
  agentName?: string;
  limit?: number;
  project?: string;
  global?: boolean;
  fallbackRecent?: boolean;
}

function agentProjectFilter(options: SearchOptions): {
  clause: string;
  params: (string | number)[];
} {
  const projectMatch = options.global
    ? { clause: "", params: [] as string[] }
    : projectMatchClause(options.project, "e", true);
  const params: (string | number)[] = [];
  if (options.agentName) params.push(options.agentName);
  params.push(...projectMatch.params);
  return {
    clause: `${options.agentName ? "AND e.agent_name = ?" : ""} ${projectMatch.clause}`,
    params,
  };
}

function recentEpisodes(
  db: DatabaseType,
  options: SearchOptions,
  limit: number,
): SearchHit[] {
  const filter = agentProjectFilter(options);
  const sql = `
    SELECT e.id, e.agent_name, e.source, e.content, e.tags, e.supersedes, e.created_at, 0 AS rank,
           (SELECT s.id FROM episodes s WHERE s.supersedes = e.id LIMIT 1) AS superseded_by
    FROM episodes e
    WHERE 1=1
    ${filter.clause}
    ORDER BY e.id DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...filter.params, limit) as SearchHit[];
}

export function searchHistory(
  db: DatabaseType,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const limit = options.limit ?? 50;
  const safeQuery = sanitizeFtsQuery(query);
  if (safeQuery.length === 0) {
    return options.fallbackRecent ? recentEpisodes(db, options, limit) : [];
  }

  const filter = agentProjectFilter(options);
  const sql = `
    SELECT e.id, e.agent_name, e.source, e.content, e.tags, e.supersedes, e.created_at, bm25(episodes_fts) AS rank,
           (SELECT s.id FROM episodes s WHERE s.supersedes = e.id LIMIT 1) AS superseded_by
    FROM episodes_fts
    JOIN episodes e ON e.id = episodes_fts.rowid
    WHERE episodes_fts MATCH ?
    ${filter.clause}
    ORDER BY rank
    LIMIT ?
  `;
  const hits = db.prepare(sql).all(safeQuery, ...filter.params, limit) as SearchHit[];
  if (hits.length > 0 || !options.fallbackRecent) return hits;

  return recentEpisodes(db, options, limit);
}

export function deleteEpisode(db: DatabaseType, id: number): boolean {
  const deleteTx = db.transaction((episodeId: number) => {
    db.prepare("UPDATE episodes SET supersedes = NULL WHERE supersedes = ?").run(episodeId);
    return db.prepare("DELETE FROM episodes WHERE id = ?").run(episodeId);
  });
  return deleteTx(id).changes > 0;
}

export function countEpisodes(db: DatabaseType, agentName?: string): number {
  if (agentName) {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE agent_name = ?")
      .get(agentName) as { n: number };
    return row.n;
  }
  const row = db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as {
    n: number;
  };
  return row.n;
}

/**
 * Count structured `memory` entries recorded since the agent's last
 * consolidation. Used to derive `needsConsolidation` from the source of
 * truth (the episodes store) rather than a prose-length proxy.
 * When `project` is provided, only rows tagged for that project are counted.
 */
export function countMemorySinceLastConsolidation(
  db: DatabaseType,
  agentName: string,
  project?: string,
): number {
  const { clause: projectClause, params: projectParams } = projectMatchClause(project);

  const last = db
    .prepare(
      `SELECT MAX(created_at) AS t FROM episodes WHERE agent_name = ? AND source = 'consolidation' ${projectClause}`,
    )
    .get(agentName, ...projectParams) as { t: string | null };

  if (last.t) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM episodes WHERE agent_name = ? AND source = 'memory' AND created_at >= ? ${projectClause}`,
      )
      .get(agentName, last.t, ...projectParams) as { n: number };
    return row.n;
  }

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM episodes WHERE agent_name = ? AND source = 'memory' ${projectClause}`,
    )
    .get(agentName, ...projectParams) as { n: number };
  return row.n;
}

function shingles(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const set = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i++) {
    set.add(normalized.slice(i, i + 3));
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Count near-duplicate pairs among the agent's `memory` rows for a project.
 * Uses lexical token Jaccard overlap (no ML) to surface "same thing, different
 * words" redundancy so `needsConsolidation` can mean "there is real redundancy
 * to collapse", not just raw volume.
 */
export function countNearDuplicates(
  db: DatabaseType,
  agentName: string,
  project?: string,
  recentLimit = 30,
): number {
  const { clause: projectClause, params: projectParams } = projectMatchClause(project);

  const rows = db
    .prepare(
      `SELECT content FROM episodes WHERE agent_name = ? AND source = 'memory' ${projectClause} ORDER BY id DESC LIMIT ?`,
    )
    .all(agentName, ...projectParams, recentLimit) as { content: string }[];

  const tokenSets = rows.map((r) => shingles(r.content));
  const redundant = new Set<number>();
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      if (
        jaccard(tokenSets[i]!, tokenSets[j]!) >=
        NEAR_DUPLICATE_JACCARD_THRESHOLD
      ) {
        redundant.add(i);
        redundant.add(j);
      }
    }
  }
  return redundant.size;
}

export interface ConsolidationStatus {
  needsConsolidation: boolean;
  rowsSinceConsolidation: number;
  nearDuplicates: number;
}

/**
 * Single source of truth for "should this agent consolidate?". Derived from the
 * structured episode store — not from MEMORY.md prose length. A trigger fires on
 * either axis: enough new `memory` rows since the last consolidation episode, or
 * enough near-duplicate redundancy among recent rows. `project` scopes the verdict
 * per project; omit it for an agent-global verdict.
 */
export function consolidationStatus(
  db: DatabaseType,
  agentName: string,
  project?: string,
): ConsolidationStatus {
  const rowsSinceConsolidation = countMemorySinceLastConsolidation(db, agentName, project);
  const nearDuplicates = countNearDuplicates(db, agentName, project);
  return {
    needsConsolidation:
      rowsSinceConsolidation >= CONSOLIDATION_TRIGGER_THRESHOLD ||
      nearDuplicates >= CONSOLIDATION_DEDUP_TRIGGER,
    rowsSinceConsolidation,
    nearDuplicates,
  };
}