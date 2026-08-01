import type { DatabaseType } from "./db.js";
import { openDatabase } from "./db.js";
import {
  addEpisode,
  getEpisode,
  findMemoryEpisodeByContent,
  searchHistory,
  consolidationStatus,
  deleteEpisode,
  countEpisodes,
  listEpisodes,
  type AddEpisodeInput,
  type SearchHit,
  type SearchOptions,
  type ConsolidationStatus,
} from "./fts.js";
import type { Episode } from "./schema.js";
import {
  MEMORY_ONLY_NOTE,
  SPARSE_CONSULT_GUIDANCE,
  SPARSE_CONSULT_THRESHOLD,
  type ConsultOutcome,
  type ConsultOptions,
} from "./engine.js";

export interface VaultOptions {
  path?: string;
  inMemory?: boolean;
  db?: DatabaseType;
}

export class AgentMemoryVault {
  private db: DatabaseType;
  private agentName: string;
  private ownsDb: boolean;
  private isClosed = false;

  constructor(agentName: string, options?: VaultOptions) {
    this.agentName = agentName;
    if (options?.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      this.db = openDatabase({
        agentName,
        path: options?.path,
        inMemory: options?.inMemory,
      });
      this.ownsDb = true;
    }
  }

  static async use<T>(
    agentName: string,
    options: VaultOptions | undefined,
    fn: (vault: AgentMemoryVault) => Promise<T>,
  ): Promise<T> {
    const vault = new AgentMemoryVault(agentName, options);
    try {
      return await fn(vault);
    } finally {
      vault.close();
    }
  }

  get rawDb(): DatabaseType {
    return this.db;
  }

  get name(): string {
    return this.agentName;
  }

  search(query: string, options?: Omit<SearchOptions, "agentName">): SearchHit[] {
    return searchHistory(this.db, query, { agentName: this.agentName, ...options });
  }

  async consult(
    query: string,
    options?: Omit<ConsultOptions, "db" | "store">,
  ): Promise<ConsultOutcome> {
    const max = typeof options?.limit === "number" ? options.limit : 10;
    const matches = this.search(query, { limit: max, project: options?.projectDir });
    const sparse = matches.length < SPARSE_CONSULT_THRESHOLD;
    const results =
      matches.length === 0
        ? this.search(query, { limit: max, project: options?.projectDir, fallbackRecent: true })
        : matches;

    const outcome: ConsultOutcome = {
      results,
      note: MEMORY_ONLY_NOTE,
    };

    if (sparse) {
      outcome.sparse = true;
      outcome.guidance = SPARSE_CONSULT_GUIDANCE;
    }

    return outcome;
  }

  addEpisode(input: Omit<AddEpisodeInput, "agentName">): Episode {
    return addEpisode(this.db, { ...input, agentName: this.agentName });
  }

  getEpisode(id: number): Episode | undefined {
    return getEpisode(this.db, id);
  }

  findMemoryEpisodeByContent(content: string, project?: string, type?: string): Episode | undefined {
    return findMemoryEpisodeByContent(this.db, this.agentName, content, project, type);
  }

  findMemoryByContent(content: string, project?: string, type?: string): Episode | undefined {
    return this.findMemoryEpisodeByContent(content, project, type);
  }

  getConsolidationStatus(project?: string): ConsolidationStatus {
    return consolidationStatus(this.db, this.agentName, project);
  }

  deleteEpisode(id: number): boolean {
    return deleteEpisode(this.db, id);
  }

  countEpisodes(): number {
    return countEpisodes(this.db, this.agentName);
  }

  listEpisodes(limit?: number): Episode[] {
    return listEpisodes(this.db, this.agentName, limit);
  }

  close(): void {
    if (this.ownsDb && !this.isClosed && this.db.open) {
      this.isClosed = true;
      this.db.close();
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
