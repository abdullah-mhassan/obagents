import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { agentExists } from "../vault/agent.js";
import { MEMORY_CHAR_LIMIT } from "../utils/constants.js";
import { getCoreFilePath } from "../vault/project.js";
import { getDbPath, type DatabaseType } from "./db.js";
import { MemoryStore } from "./store.js";
import { pruneStaleEpisodes } from "./decay.js";

export async function checkMemoryOverflow(agent: string, projectDir?: string): Promise<boolean> {
  if (!agentExists(agent)) {
    throw new Error(`Agent "${agent}" does not exist. Run: obagents create ${agent}`);
  }
  const store = new MemoryStore(agent);
  try {
    return store.getConsolidationStatus(projectDir).needsConsolidation;
  } finally {
    store.close();
  }
}

async function readMemory(agent: string, projectDir?: string): Promise<string> {
  const path = getCoreFilePath(agent, "MEMORY.md", projectDir);
  if (!existsSync(path)) return "";
  return readFile(path, "utf8");
}

export interface ConsolidateOptions {
  db?: DatabaseType;
  store?: MemoryStore;
  tags?: string | string[] | null;
  projectDir?: string;
  autoPrune?: boolean;
}

export interface ConsolidateResult {
  agent: string;
  archivedContent: string;
  summaryContent: string;
  episodeId: number;
  dbPath: string;
}

export async function consolidateMemory(
  agent: string,
  summary: string,
  options: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  if (!agentExists(agent)) {
    throw new Error(`Agent "${agent}" does not exist. Run: obagents create ${agent}`);
  }
  if (summary.length > MEMORY_CHAR_LIMIT) {
    throw new Error(
      `Consolidation summary (${summary.length} characters) exceeds the limit of ${MEMORY_CHAR_LIMIT}. Provide a shorter summary.`,
    );
  }

  const currentContent = await readMemory(agent, options.projectDir);
  const memoryPath = getCoreFilePath(agent, "MEMORY.md", options.projectDir);

  const store = options.store ?? new MemoryStore(agent, options.db ? { db: options.db } : undefined);
  const ownsStore = !options.store && !options.db;
  try {
    let tags = options.tags;
    if (!tags) {
      tags = options.projectDir
        ? ["consolidation", agent, options.projectDir]
        : ["consolidation", agent];
    }
    const episode = store.addEpisode({
      source: "consolidation",
      content: currentContent,
      tags,
    });

    await mkdir(dirname(memoryPath), { recursive: true });
    await writeFile(memoryPath, summary.endsWith("\n") ? summary : `${summary}\n`, "utf8");

    if (options.autoPrune !== false) {
      await pruneStaleEpisodes(agent, { db: store.rawDb });
    }

    return {
      agent,
      archivedContent: currentContent,
      summaryContent: summary,
      episodeId: episode.id,
      dbPath: getDbPath(agent),
    };
  } finally {
    if (ownsStore) store.close();
  }
}

export { MEMORY_CHAR_LIMIT };