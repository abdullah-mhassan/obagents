import { join } from "node:path";
import { TRIAD_FILES } from "../utils/constants.js";
import { getAgentDir, TEMPLATES_DIR } from "../utils/paths.js";
import { projectVault, normalizeProjectPath } from "../vault/project.js";
import { getAgentMeta, setCachedConsolidationStatus } from "./metadata.js";
import type { CompiledAgent } from "../linker/types.js";
import { fs } from "../utils/fs.js";
import { getDbPath } from "../memory/db.js";
import { MemoryStore } from "../memory/store.js";

export type CoreFile = "SOUL.md" | "MEMORY.md" | "USER.md";
export const CORE_FILES: readonly CoreFile[] = ["SOUL.md", "MEMORY.md", "USER.md"] as const;
export { TRIAD_FILES };

export const ARCHETYPE_NAMES = ["engineer", "designer", "copywriter", "orchestrator"] as const;
export type ArchetypeName = (typeof ARCHETYPE_NAMES)[number];
const ARCHETYPE_NAME_SET: ReadonlySet<string> = new Set(ARCHETYPE_NAMES);

export function resolveTemplateDir(template: string): string {
  if (ARCHETYPE_NAME_SET.has(template)) {
    return join(TEMPLATES_DIR, "archetypes", template);
  }
  return template;
}

export const CORE_DIRECTIVES_VERSION = 1;
const CORE_DIRECTIVES_START = `<!-- obagents:core-directives v${CORE_DIRECTIVES_VERSION} -->`;
const CORE_DIRECTIVES_START_ANY = /<!--\s*obagents:core-directives v(\d+)\s*-->/i;
const CORE_DIRECTIVES_END = "<!-- obagents:core-directives:end -->";
const CORE_DIRECTIVES_BLOCK_REGEX =
  /<!--\s*obagents:core-directives v\d+\s*-->[\s\S]*?<!--\s*obagents:core-directives:end\s*-->\n?/i;

const CORE_DIRECTIVES_BODY = `## Core Directives
- Be direct, precise, and honest.
- Always ask for clarification if requirements are ambiguous.
- Prioritize maintainable and clean solutions.

Persist learnings at milestones, unprompted. Trust AGENTS.md for what counts as a milestone in a given project; absent that file, use judgment — build passes, decisions finalized, and bugs fixed count; partial work does not.`;

export function buildCoreDirectivesBlock(): string {
  return `${CORE_DIRECTIVES_START}\n${CORE_DIRECTIVES_BODY}\n${CORE_DIRECTIVES_END}`;
}

export function coreDirectivesVersionIn(soul: string): number | null {
  const match = CORE_DIRECTIVES_START_ANY.exec(soul);
  return match ? Number(match[1]) : null;
}

export function ensureCoreDirectives(soul: string): string {
  const block = buildCoreDirectivesBlock();
  const currentVersion = coreDirectivesVersionIn(soul);

  if (currentVersion === CORE_DIRECTIVES_VERSION) {
    return soul;
  }

  if (currentVersion !== null) {
    return soul.replace(CORE_DIRECTIVES_BLOCK_REGEX, `${block}\n`);
  }

  const trimmed = soul.replace(/\s+$/, "");
  return `${trimmed}\n\n${block}\n`;
}

export const DEFAULT_SOUL_TEMPLATE = `# {{AGENT_NAME}}

## Role

{{AGENT_DESCRIPTION}}

## Operating principles

- Focus on the user’s outcome and make progress with the information available.
- Prefer clear, maintainable solutions over clever or speculative ones.
- State important assumptions, risks, and trade-offs plainly.
- Verify meaningful changes before claiming they work.
- Respect the project’s documented conventions and constraints.
`;

export const DEFAULT_MEMORY_TEMPLATE = `# Working Memory

> A concise summary of the current project context. Record durable milestones with
> \`update_state\`; refresh this summary through consolidation when it becomes stale.

## Current objective

- No active objective recorded.

## Confirmed decisions

- None recorded.

## Active work

- None recorded.

## Open risks or questions

- None recorded.
`;

export const DEFAULT_USER_TEMPLATE = `# User Context

## Preferences

- None recorded.

## Goals

- None recorded.

## Constraints

- None recorded.
`;

export function isDefaultUserContext(content: string): boolean {
  if (!content || !content.trim()) return true;
  const normActual = content.replace(/\r\n/g, "\n").trim();
  const normDefault = DEFAULT_USER_TEMPLATE.replace(/\r\n/g, "\n").trim();
  if (normActual === normDefault) return true;

  const stripped = normActual
    .replace(/^# User Context/m, "")
    .replace(/^## Preferences/m, "")
    .replace(/^## Goals/m, "")
    .replace(/^## Constraints/m, "")
    .replace(/^- None recorded\./gm, "")
    .trim();

  return stripped.length === 0;
}

function defaultContent(file: CoreFile): string {
  const templates: Record<CoreFile, string> = {
    "SOUL.md": DEFAULT_SOUL_TEMPLATE,
    "MEMORY.md": DEFAULT_MEMORY_TEMPLATE,
    "USER.md": DEFAULT_USER_TEMPLATE,
  };
  return templates[file];
}

export async function writeCoreTo(
  targetDir: string,
  name: string,
  description: string,
  templateDir?: string,
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });

  const effectiveDescription = description || "A highly capable AI assistant.";
  const resolvedTemplateDir = templateDir ? resolveTemplateDir(templateDir) : undefined;

  for (const file of TRIAD_FILES) {
    const dstPath = join(targetDir, file);
    const srcPath = resolvedTemplateDir ? join(resolvedTemplateDir, file) : null;

    let content: string;
    if (srcPath && fs.existsSync(srcPath)) {
      content = await fs.readFile(srcPath, "utf8");
    } else {
      content = defaultContent(file);
    }

    content = content
      .replaceAll("{{AGENT_NAME}}", name)
      .replaceAll("{{AGENT_DESCRIPTION}}", effectiveDescription);

    if (file === "SOUL.md") {
      content = ensureCoreDirectives(content);
    }

    await fs.writeFile(dstPath, content, "utf8");
  }
}

export const HIVE_PROTOCOL_SECTION = `## Hive Protocol

- For another agent’s knowledge, use \`consult_agent\` for a focused question or
  \`load_agent_context\` for its full context.
- If consultation is sparse, report that result and get approval before expensive
  exploration or delegation.
- Delegate only bounded tasks with a clear owner and expected outcome.
- Reuse a teammate’s recorded findings; do not repeat completed investigation.`;

export interface CompileRosterOptions {
  extraAgents?: string[];
}

export async function compileRosterContext(
  projectDir?: string,
  rosterAgents: string[] = [],
  activeAgent?: string,
  options?: CompileRosterOptions | string[],
): Promise<string> {
  const extraAgents = Array.isArray(options) ? options : options?.extraAgents ?? [];
  const allAgents = Array.from(new Set([...rosterAgents, ...extraAgents]));
  const effectiveActive = activeAgent ?? (allAgents.length > 0 ? allAgents[0] : undefined);

  let roster = `# 🛡️ OB Agents Hive\n\n`;
  roster += `You are operating in a multi-agent environment managed by the OB Agents CLI.\n`;
  roster += `Instead of loading massive system prompts directly, you are the Orchestrator.\n`;
  roster += `If the user @mentions a specific agent, or asks for help from a specific agent, you MUST use the \`load_agent_context\` MCP tool to dynamically retrieve their rules, persona, and memory before responding. Pass the agent name WITHOUT the leading '@' (e.g. targetAgent: "odba").\n\n`;

  if (effectiveActive) {
    roster += `**Active Runtime Agent:** @${effectiveActive}\n`;
    roster += `*(If no other agent is mentioned, you should assume the persona and rules of the Active Runtime Agent by loading their context immediately.)*\n\n`;
  } else {
    roster += `**Active Runtime Agent:** None set. (Act as a neutral orchestrator unless instructed otherwise).\n\n`;
  }

  roster += `**Available Hive Members:**\n`;
  if (allAgents.length === 0) {
    roster += `- No agents currently linked to this project.\n`;
  } else {
    for (const agent of allAgents) {
      const meta = await getAgentMeta(agent);
      const dateStr = meta?.createdAt
        ? ` (Linked/Created: ${new Date(meta.createdAt).toISOString().split("T")[0]})`
        : "";
      roster += `- @${agent}${dateStr}\n`;
    }
  }

  roster += `\n${HIVE_PROTOCOL_SECTION}`;

  return roster;
}

export async function compileRoster(
  projectDir?: string,
  rosterAgents: string[] = [],
  activeAgent?: string,
  extraAgents: string[] = [],
): Promise<string> {
  return compileRosterContext(projectDir, rosterAgents, activeAgent, { extraAgents });
}

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

export interface CompileAgentOptions {
  extraSections?: string[];
}

export async function compileAgentContext(
  agentName: string,
  projectDir?: string,
  options?: CompileAgentOptions,
): Promise<CompiledAgent> {
  const agentDir = getAgentDir(agentName);
  if (!fs.existsSync(agentDir)) {
    throw new Error(`Agent "${agentName}" does not exist. Run: obagents create ${agentName}`);
  }

  const rawSections = await Promise.all(
    TRIAD_FILES.map(async (file) => {
      const path = projectVault.getCoreFilePath(agentName, file, projectDir);
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
  const dbPath = getDbPath(agentName);
  if (fs.existsSync(dbPath)) {
    const meta = await getAgentMeta(agentName);
    const key = projectDir ? normalizeProjectPath(projectDir) : "__global__";
    if (meta?.consolidationCache && key in meta.consolidationCache) {
      needsConsolidation = meta.consolidationCache[key]!;
    } else {
      const store = new MemoryStore(agentName);
      needsConsolidation = store.getConsolidationStatus(projectDir).needsConsolidation;
      store.close();
      await setCachedConsolidationStatus(agentName, projectDir, needsConsolidation);
    }
  }

  const compiledContent = activeSections
    .map((section) => `## ${section.file.replace(/\.md$/, "")}\n\n${section.content}`)
    .join("\n\n");

  const extra = options?.extraSections
    ? options.extraSections
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n\n")
    : "";

  const fullContent = [compiledContent.trim(), extra, RUNTIME_PROTOCOL_SECTION]
    .filter(Boolean)
    .join("\n\n");

  return {
    content: `${fullContent}\n`,
    needsConsolidation,
  };
}

export async function compileAgent(
  name: string,
  projectDir?: string,
  options?: CompileAgentOptions,
): Promise<CompiledAgent> {
  return compileAgentContext(name, projectDir, options);
}