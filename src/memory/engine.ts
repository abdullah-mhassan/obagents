import type { DatabaseType } from "./db.js";
import { type SearchHit } from "./fts.js";
import { agentExists, normalizeAgentName } from "../vault/agent.js";
import { AgentMemoryVault } from "./vault.js";

export const MEMORY_ONLY_NOTE =
  "This was a deterministic lookup of this agent's recorded episode log (decisions, tool-call records, skills, and consolidation summaries), scoped to the agent's vault: no project files were read and no web search was performed.";
export const SPARSE_CONSULT_GUIDANCE =
  "Sparse memory for this query. Report this thin result to the user and ask for approval before any expensive step (spawning a live sub-agent, bulk file reads, or web search). Do not auto-escalate.";
export const SPARSE_CONSULT_THRESHOLD = 2;

export interface ConsultOutcome {
  results: SearchHit[];
  note: string;
  sparse?: boolean;
  guidance?: string;
}

export interface ConsultOptions {
  projectDir?: string;
  limit?: number;
  db?: DatabaseType;
  store?: AgentMemoryVault;
}

export async function consultAgentMemory(
  targetAgent: string,
  query: string,
  options?: ConsultOptions,
): Promise<ConsultOutcome> {
  const agent = normalizeAgentName(targetAgent);
  if (!agentExists(agent)) {
    throw new Error(`Agent "${agent}" does not exist.`);
  }

  if (options?.store) {
    return options.store.consult(query, options);
  }

  return AgentMemoryVault.use(
    agent,
    options?.db ? { db: options.db } : undefined,
    async (vault) => vault.consult(query, options),
  );
}
