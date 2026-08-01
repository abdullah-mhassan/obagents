import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryStore } from "../../memory/store.js";
import { agentExists, createAgent, validateAgentName } from "../../vault/agent.js";
import { compileAgent } from "../../vault/compiler.js";
import { vaultSync, vaultSyncEngine } from "../../vault/sync.js";
import { consolidateMemory } from "../../memory/consolidation.js";
import { errorResult, jsonResult, logToolCall, messageOf, type RegisterToolsOptions } from "./utils.js";
import { SUPPORTED_TARGETS } from "../../utils/constants.js";

import { consultAgentMemory, MEMORY_ONLY_NOTE } from "../../memory/engine.js";

async function resolveLogAgent(
  servingAgent: string,
  options: RegisterToolsOptions,
): Promise<string> {
  if (!options.resolveGateway) return servingAgent;
  try {
    const resolved = await options.resolveGateway({});
    return resolved.agent;
  } catch {
    return servingAgent;
  }
}

async function runHiveAction<T>(
  servingAgent: string,
  toolName: string,
  args: T,
  options: RegisterToolsOptions,
  action: () => Promise<unknown>,
) {
  const logAgent = await resolveLogAgent(servingAgent, options);
  try {
    const result = await action();
    const store = options.store ?? (logAgent && agentExists(logAgent) ? new MemoryStore(logAgent, options.db ? { db: options.db } : undefined) : undefined);
    if (store) {
      try {
        logToolCall(store, logAgent, toolName, args, "ok", options.projectDir);
      } finally {
        if (!options.store) store.close();
      }
    }
    return jsonResult(result);
  } catch (error) {
    const msg = messageOf(error);
    const store = options.store ?? (logAgent && agentExists(logAgent) ? new MemoryStore(logAgent, options.db ? { db: options.db } : undefined) : undefined);
    if (store) {
      try {
        logToolCall(store, logAgent, toolName, args, `error: ${msg}`, options.projectDir);
      } finally {
        if (!options.store) store.close();
      }
    }
    return errorResult(msg);
  }
}

async function resolveProjectDirAndCheckRoster(
  agent: string,
  projectParam: string | undefined,
  options: RegisterToolsOptions,
): Promise<{ projectDir: string | undefined; error?: string }> {
  if (options.resolveGateway) {
    const projectDir = (await options.resolveGateway({ project: projectParam })).projectDir;
    const roster = await vaultSyncEngine.getAgentsForProject(projectDir);
    if (!roster.includes(agent)) {
      return {
        projectDir,
        error: `Agent "${agent}" is not linked to project "${projectDir}". Linked agents: ${roster.join(", ")}`,
      };
    }
    return { projectDir };
  }
  return { projectDir: options.projectDir };
}

export function registerHiveTools(
  server: McpServer,
  agentName: string, // The agent running the MCP server
  options: RegisterToolsOptions = {},
): void {

  server.tool(
    "create_agent",
    "Initialize a new AI agent in the Vault. Use this to spawn a worker or a specialist for a task. Pass the agent name WITHOUT the leading '@' (e.g. name: \"odba\").",
    { name: z.string(), description: z.string() },
    async ({ name, description }) => {
      return runHiveAction(agentName, "create_agent", { name, description }, options, async () => {
        const validated = validateAgentName(name);
        const result = await createAgent(validated, { description });
        return { success: true, agent: result.name, path: result.path };
      });
    }
  );

  server.tool(
    "link_agent",
    `Assign an existing agent to a specific project workspace. This injects the agent's context into the project. projectPath defaults to the current working directory if omitted. Valid targets: [${SUPPORTED_TARGETS.join(", ")}].`,
    { name: z.string(), targets: z.array(z.string()), projectPath: z.string().optional() },
    async ({ name, targets, projectPath }) => {
      return runHiveAction(agentName, "link_agent", { name, targets, projectPath }, options, async () => {
        const validated = validateAgentName(name);
        const outcome = await vaultSync.linkAgent(validated, {
          targets,
          projectDir: projectPath,
        });
        return { success: true, outcome };
      });
    }
  );

  server.tool(
    "consolidate_agent",
    "Archive an agent's current MEMORY.md and replace it with a shorter summary to save context window space.",
    { name: z.string(), summary: z.string() },
    async ({ name, summary }) => {
      return runHiveAction(agentName, "consolidate_agent", { name }, options, async () => {
        const validated = validateAgentName(name);
        const outcome = await consolidateMemory(validated, summary, { projectDir: options.projectDir, store: options.store, db: options.db });
        return { success: true, episodeId: outcome.episodeId };
      });
    }
  );

  server.tool(
    "load_agent_context",
    "Dynamically retrieve another agent's rules, persona, and memory. This is a cheap, memory-only read (no files or web). REQUIRED: targetAgent — the agent name WITHOUT the leading '@' (e.g. targetAgent: \"odba\").",
    { targetAgent: z.string(), project: z.string().optional() },
    async ({ targetAgent, project }) => {
      try {
        const agent = validateAgentName(targetAgent);
        if (!agentExists(agent)) {
          return errorResult(`Agent "${agent}" does not exist.`);
        }
        const { projectDir, error } = await resolveProjectDirAndCheckRoster(agent, project, options);
        if (error) return errorResult(error);
        const compiled = await compileAgent(agent, projectDir);
        return jsonResult({ memory: compiled.content, note: MEMORY_ONLY_NOTE });
      } catch (error) {
        return errorResult(messageOf(error));
      }
    }
  );

  server.tool(
    "consult_agent",
    "Query another agent's memory deterministically to discover their past decisions. This is the ONLY reliably scoped way to read another agent's memory: a cheap, memory-only lookup scoped to that agent's vault (no files or web) — not task execution; do not escalate to a live sub-agent without user approval. Do NOT substitute a generic search_history, file reads, or web search to find another agent's memory — those aren't scoped to the agent and will miss it. For full rules + memory, use load_agent_context. REQUIRED: targetAgent — the agent name WITHOUT the leading '@' (e.g. targetAgent: \"odba\").",
    { targetAgent: z.string(), query: z.string(), limit: z.number().optional(), project: z.string().optional() },
    async ({ targetAgent, query, limit, project }) => {
      try {
        const validated = validateAgentName(targetAgent);
        const { projectDir, error } = await resolveProjectDirAndCheckRoster(validated, project, options);
        if (error) return errorResult(error);
        const outcome = await consultAgentMemory(validated, query, { limit, projectDir, store: options.store, db: options.db });
        return jsonResult(outcome);
      } catch (error) {
        return errorResult(messageOf(error));
      }
    }
  );
}
