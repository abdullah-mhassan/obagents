import { TRIAD_FILES } from "../utils/constants.js";
import { getAgentDir } from "../utils/paths.js";
import { projectVault, normalizeProjectPath } from "../vault/project.js";
import { getAgentMeta, setCachedConsolidationStatus } from "./metadata.js";
import type { CompiledAgent } from "../linker/types.js";
import { fs } from "../utils/fs.js";
import { getDbPath } from "../memory/db.js";
import { MemoryStore } from "../memory/store.js";
import { isDefaultUserContext } from "./triad.js";

export const RUNTIME_PROTOCOL_SECTION = `## OB Agents Runtime Protocol

- Treat \`SOUL.md\` as stable role guidance, \`MEMORY.md\` as current project context,
  and \`USER.md\` as user-provided preferences.
- Record only durable outcomes with \`update_state\`:
  - a verified build or test recovery;
  - a finalized decision;
  - a bug with both root cause and fix;
  - a completed, testable milestone.
- Keep entries atomic and concise. Do not record in-progress work or repeated updates.
- When the working-memory summary is stale, consolidate it instead of appending noise.
- Before reporting completion, run the relevant verification and state what passed.`;

export async function compileAgent(name: string, projectDir?: string): Promise<CompiledAgent> {
  const agentDir = getAgentDir(name);
  if (!fs.existsSync(agentDir)) {
    throw new Error(`Agent "${name}" does not exist. Run: obagents create ${name}`);
  }

  const rawSections = await Promise.all(
    TRIAD_FILES.map(async (file) => {
      const path = projectVault.getCoreFilePath(name, file, projectDir);
      const content = fs.existsSync(path) ? await fs.readFile(path, "utf8") : "";
      return { file, content: content.replace(/\s+$/, "") };
    }),
  );

  const activeSections = rawSections.filter((section) => {
    if (!section.content.trim()) return false;
    if (section.file === "USER.md" && isDefaultUserContext(section.content)) {
      return false;
    }
    return true;
  });

  let needsConsolidation = false;
  const dbPath = getDbPath(name);
  if (fs.existsSync(dbPath)) {
    const meta = await getAgentMeta(name);
    const key = projectDir ? normalizeProjectPath(projectDir) : "__global__";
    if (meta?.consolidationCache && key in meta.consolidationCache) {
      needsConsolidation = meta.consolidationCache[key]!;
    } else {
      const store = new MemoryStore(name);
      needsConsolidation = store.getConsolidationStatus(projectDir).needsConsolidation;
      store.close();
      await setCachedConsolidationStatus(name, projectDir, needsConsolidation);
    }
  }

  const compiledContent = activeSections
    .map((section) => `## ${section.file.replace(/\.md$/, "")}\n\n${section.content}`)
    .join("\n\n");

  return {
    content: `${compiledContent.trim()}\n\n${RUNTIME_PROTOCOL_SECTION}\n`,
    needsConsolidation,
  };
}