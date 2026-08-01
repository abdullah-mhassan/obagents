import { z } from "zod";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NAME_PATTERN,
  SANITIZE_PATTERN,
  MEMORY_ENTRY_TYPES,
  STRUCTURED_MEMORY_VERSION,
  MAX_UPDATE_STATE_CHARS,
  CONSOLIDATION_TRIGGER_THRESHOLD,
  GLOBAL_PROJECT_TAG,
  SKILL_EPISODE_SNIPPET_CHARS,
} from "../../utils/constants.js";
import { getAgentDir } from "../../utils/paths.js";
import { encodeProjectTag } from "../../memory/project-tag.js";
import { compileAgent } from "../../vault/compiler.js";
import { setCachedConsolidationStatus } from "../../vault/metadata.js";
import { withAgentContext, type RegisterToolsOptions } from "./utils.js";

export function registerMemoryTools(
  server: McpServer,
  agentName: string,
  options: RegisterToolsOptions = {},
): void {
  server.tool(
    "read_state",
    "Read the agent's full compiled state (SOUL, MEMORY, and USER).",
    {
      targetAgent: z.string().optional(),
      project: z.string().optional(),
    },
    withAgentContext(agentName, "read_state", options, async (_args, _store, servedProject, resolvedAgent) => {
      const compiled = await compileAgent(resolvedAgent, servedProject);
      return { memory: compiled.content };
    }),
  );

  server.tool(
    "update_state",
    "Record a structured memory entry (typed milestone) into the agent's deep-memory store. Requires `type` and `summary` (as of v" +
      STRUCTURED_MEMORY_VERSION +
      "). MEMORY.md remains the agent's readable prose view.",
    {
      type: z.enum(MEMORY_ENTRY_TYPES, {
        errorMap: () => ({
          message: `update_state now requires \`type\` and \`summary\` (as of v${STRUCTURED_MEMORY_VERSION}). Re-run \`obagents sync <agent>\` in this project to refresh the tool schema.`,
        }),
      }),
      summary: z.string().min(1, {
        message: `update_state now requires \`type\` and \`summary\` (as of v${STRUCTURED_MEMORY_VERSION}). Re-run \`obagents sync <agent>\` in this project to refresh the tool schema.`,
      }).max(MAX_UPDATE_STATE_CHARS, {
        message: `summary exceeds the ${MAX_UPDATE_STATE_CHARS}-character (~2KB) cap. Keep entries atomic — split into multiple update_state calls.`,
      }),
      supersedes: z.number().int().positive().optional(),
      project: z.string().optional(),
      targetAgent: z.string().optional(),
    },
    withAgentContext(agentName, "update_state", options, async ({ type, summary, supersedes, project }, store, servedProject, resolvedAgent) => {
      if (!type || !summary) {
        throw new Error(
          `update_state now requires \`type\` and \`summary\` (as of v${STRUCTURED_MEMORY_VERSION}). Re-run \`obagents sync ${resolvedAgent}\` in this project to refresh the tool schema.`,
        );
      }

      if (summary.length > MAX_UPDATE_STATE_CHARS) {
        throw new Error(
          `summary exceeds the ${MAX_UPDATE_STATE_CHARS}-character (~2KB) cap. Keep entries atomic — split into multiple update_state calls.`,
        );
      }

      if (supersedes !== undefined) {
        const target = store.getEpisode(supersedes);
        if (!target || target.agent_name !== resolvedAgent) {
          throw new Error(`supersedes: episode #${supersedes} not found for agent "${resolvedAgent}".`);
        }
      }

      const scopedProject = project ?? servedProject ?? GLOBAL_PROJECT_TAG;

      const existing = store.findMemoryEpisodeByContent(summary, scopedProject, type);
      if (existing) {
        const status = store.getConsolidationStatus(scopedProject);
        await setCachedConsolidationStatus(resolvedAgent, scopedProject, status.needsConsolidation);
        return {
          success: true,
          entryId: existing.id,
          type,
          supersedes: supersedes ?? null,
          project: scopedProject,
          needsConsolidation: status.needsConsolidation,
          rowsSinceConsolidation: status.rowsSinceConsolidation,
          threshold: CONSOLIDATION_TRIGGER_THRESHOLD,
          nearDuplicates: status.nearDuplicates,
          duplicate: true,
        };
      }

      const tags = encodeProjectTag(type, scopedProject);
      const episode = store.addEpisode({
        source: "memory",
        content: summary,
        tags,
        supersedes: supersedes ?? null,
      });

      const status = store.getConsolidationStatus(scopedProject);
      await setCachedConsolidationStatus(resolvedAgent, scopedProject, status.needsConsolidation);

      return {
        success: true,
        entryId: episode.id,
        type,
        supersedes: supersedes ?? null,
        project: scopedProject,
        needsConsolidation: status.needsConsolidation,
        rowsSinceConsolidation: status.rowsSinceConsolidation,
        threshold: CONSOLIDATION_TRIGGER_THRESHOLD,
        nearDuplicates: status.nearDuplicates,
      };
    }),
  );

  server.tool(
    "search_history",
    "Search the agent's long-term episodic memory via FTS5. Returns ranked episodes matching the query. Results include `superseded_by`; treat entries marked superseded as historical, not current.",
    {
      query: z.string(),
      limit: z.number().optional(),
      global: z.boolean().optional(),
      targetAgent: z.string().optional(),
      project: z.string().optional(),
    },
    withAgentContext(agentName, "search_history", options, async ({ query, limit, global }, store, servedProject) => {
      const results = store.search(query, {
        limit: typeof limit === "number" ? limit : 10,
        project: global ? undefined : servedProject,
        global,
      });
      return { results };
    }),
  );

  server.tool(
    "learn_skill",
    "Save a skill as skills/<name>/SKILL.md inside the agent's vault and record an episode. The skill name must match ^[a-z0-9-_]+$.",
    {
      name: z.string(),
      protocol: z.string(),
      targetAgent: z.string().optional(),
      project: z.string().optional(),
    },
    withAgentContext(agentName, "learn_skill", options, async ({ name, protocol }, store, _servedProject, resolvedAgent) => {
      const skillName = name.toLowerCase().replace(SANITIZE_PATTERN, "");
      if (!NAME_PATTERN.test(skillName) || skillName.length === 0) {
        throw new Error(
          `Invalid skill name "${name}". Names may only contain lowercase letters, digits, hyphens, and underscores.`
        );
      }

      const skillDir = join(getAgentDir(resolvedAgent), "skills", skillName);
      const skillPath = join(skillDir, "SKILL.md");

      try {
        const existingContent = await readFile(skillPath, "utf8");
        if (existingContent === protocol) {
          return { success: true, unchanged: true, path: skillPath };
        }
      } catch {
        // File does not exist or read failed; proceed to write and create episode.
      }

      await mkdir(skillDir, { recursive: true });
      await writeFile(skillPath, protocol, "utf8");

      const sha = createHash("sha1").update(protocol).digest("hex").slice(0, 8);
      const match = protocol.match(/description:\s*(.+)/);
      const rawSnippetText = match && match[1] ? match[1] : protocol;
      const flattened = rawSnippetText.replace(/\s+/g, " ").trim();
      const snippet =
        flattened.length > SKILL_EPISODE_SNIPPET_CHARS
          ? `${flattened.slice(0, SKILL_EPISODE_SNIPPET_CHARS)}...`
          : flattened;

      const pointerContent = `skill=${skillName} sha=${sha} chars=${protocol.length} "${snippet}"`;

      store.addEpisode({
        source: "skill",
        content: pointerContent,
        tags: ["skill", skillName],
      });

      return { success: true, path: skillPath };
    }),
  );
}
