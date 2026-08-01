export { AgentMemoryVault, type VaultOptions } from "./vault.js";
export { MemoryStore, type MemoryStoreOptions } from "./store.js";
export type { Episode } from "./schema.js";
export type {
  SearchHit,
  AddEpisodeInput,
  ConsolidationStatus,
  SearchOptions,
  EpisodeSource,
} from "./fts.js";
export type { DatabaseOptions, DatabaseType } from "./db.js";
export { openDatabase, getDbPath } from "./db.js";
export {
  addEpisode,
  getEpisode,
  findMemoryEpisodeByContent,
  searchHistory,
  consolidationStatus,
  deleteEpisode,
  countEpisodes,
  listEpisodes,
} from "./fts.js";
export {
  consultAgentMemory,
  MEMORY_ONLY_NOTE,
  SPARSE_CONSULT_GUIDANCE,
  SPARSE_CONSULT_THRESHOLD,
  type ConsultOutcome,
  type ConsultOptions,
} from "./engine.js";
export {
  checkMemoryOverflow,
  consolidateMemory,
  type ConsolidateOptions,
  type ConsolidateResult,
} from "./consolidation.js";
export {
  encodeProjectTag,
  projectMatchClause,
} from "./project-tag.js";
export {
  pruneStaleEpisodes,
  type PruneOptions,
  type PruneResult,
} from "./decay.js";
export {
  rebuildJsonlFromDb,
  rebuildDbFromJsonl,
  type RebuildJsonlOptions,
  type RebuildDbOptions,
} from "./rebuild.js";
export {
  generateMemoryTree,
  type TreeOptions,
} from "./tree.js";

