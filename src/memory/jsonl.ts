import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getAgentDir } from "../utils/paths.js";
import { EPISODES_JSONL_FILE_NAME } from "../utils/constants.js";
import type { Episode } from "./schema.js";

export function getJsonlPath(agentName: string): string {
  return `${getAgentDir(agentName)}/${EPISODES_JSONL_FILE_NAME}`;
}

const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Queue a job on the per-file write chain for an agent's mirror. Jobs for the
 * same file run strictly in order; a rebuild enqueued this way can never
 * interleave with pending appends. Errors propagate to the caller while the
 * chain itself stays alive for subsequent jobs.
 */
export function enqueueJsonlJob<T>(agentName: string, job: () => Promise<T>): Promise<T> {
  const path = getJsonlPath(agentName);
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const result = previous.then(job, job);
  writeQueues.set(path, result.then(() => undefined, () => undefined));
  return result;
}

/** Append one episode as a single JSON line using non-blocking asynchronous file appends. */
export function appendEpisodeToJsonl(agentName: string, episode: Episode): Promise<void> {
  const path = getJsonlPath(agentName);
  const line = JSON.stringify(episode) + "\n";

  return enqueueJsonlJob(agentName, async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, "utf8");
  }).catch(() => {});
}
