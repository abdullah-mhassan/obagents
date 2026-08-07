import { dirname } from "node:path";
import { fs } from "../utils/fs.js";
import { getCoreFilePath } from "../vault/project.js";
import { MEMORY_CHAR_LIMIT } from "../utils/constants.js";
import { DEFAULT_MEMORY_TEMPLATE } from "../vault/compiler.js";

export interface AppendMemoryResult {
  appended: boolean;
  skipped: "duplicate" | "char-limit" | null;
}

const HEADING = "## Latest state";
const HEADING_RE = /^#{1,6}\s+Latest\s*state\s*$/i;
const ANY_HEADING_RE = /^#{1,6}\s+\S/;

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function insertBullet(content: string, bullet: string): string {
  const lines = content.split("\n");

  const headingIdx = lines.findIndex((l) => HEADING_RE.test(l));
  if (headingIdx === -1) {
    const base = content.replace(/\s+$/, "");
    const header = base === "" ? HEADING : `${base}\n\n${HEADING}`;
    return `${header}\n\n${bullet}\n`;
  }

  let insertAt = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && ANY_HEADING_RE.test(line)) {
      insertAt = i;
      break;
    }
  }
  lines.splice(insertAt, 0, bullet);
  return lines.join("\n");
}

/**
 * Mirror a freshly recorded structured entry into the agent's prose working
 * memory (MEMORY.md) so the passive/shared memory view is live without waiting
 * for consolidation. Best-effort and idempotent:
 *  - skips when the exact bullet already exists;
 *  - refuses to write when the result would exceed MEMORY_CHAR_LIMIT;
 *  - writes atomically through `fs` (tmp file + rename), so the file is never
 *    left half-written.
 *
 * `projectDir` undefined means the global agent-root MEMORY.md; a value scopes
 * to that project's memory file via getCoreFilePath.
 */
export async function appendMemoryBullet(
  agent: string,
  projectDir: string | undefined,
  type: string,
  summary: string,
): Promise<AppendMemoryResult> {
  const memoryPath = getCoreFilePath(agent, "MEMORY.md", projectDir);
  const bullet = `- ${type}: ${summary}`;

  let content = DEFAULT_MEMORY_TEMPLATE.replaceAll("{{AGENT_NAME}}", agent);
  if (fs.existsSync(memoryPath)) {
    content = normalizeNewlines(await fs.readFile(memoryPath, "utf8"));
  }

  // Idempotent: skip an entry whose exact bullet is already present.
  if (content.includes(bullet)) {
    return { appended: false, skipped: "duplicate" };
  }

  const next = insertBullet(content, bullet);
  if (next.length > MEMORY_CHAR_LIMIT) {
    return { appended: false, skipped: "char-limit" };
  }

  await fs.mkdir(dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, next, "utf8");
  return { appended: true, skipped: null };
}