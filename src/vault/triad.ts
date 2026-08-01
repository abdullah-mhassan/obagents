import { join } from "node:path";
import { fs } from "../utils/fs.js";
import { TEMPLATES_DIR } from "../utils/paths.js";

type CoreFile = "SOUL.md" | "MEMORY.md" | "USER.md";
export const CORE_FILES: readonly CoreFile[] = ["SOUL.md", "MEMORY.md", "USER.md"] as const;
export const TRIAD_FILES = CORE_FILES;

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

export async function writeCoreTo(targetDir: string, name: string, description: string, templateDir?: string): Promise<void> {
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

