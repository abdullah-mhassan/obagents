import { getAgentDir, getAgentsDir } from "../utils/paths.js";
import { readRegistry, updateRegistry } from "./registry.js";
import { initializeAgentMeta, getAgentMeta, type AgentMeta } from "./metadata.js";
import { writeCoreTo } from "./triad.js";
import { fs } from "../utils/fs.js";
import { NAME_PATTERN, SANITIZE_PATTERN } from "../utils/constants.js";
import { vaultGraph } from "./link-graph.js";
import { targetAdapterEngine } from "../linker/engine.js";

export interface CreateAgentResult {
  name: string;
  createdAt: string;
  path: string;
  overwritten: boolean;
}

export async function createAgent(name: string, options?: { force?: boolean; description?: string; template?: string }): Promise<CreateAgentResult> {
  const agentDir = getAgentDir(name);
  const overwritten = fs.existsSync(agentDir);
  if (overwritten && !options?.force) {
    throw new Error(`Agent "${name}" already exists. Use --force to overwrite.`);
  }

  if (overwritten && options?.force) {
    await cleanupAgentIntegrations(name);
  }

  await fs.mkdir(getAgentsDir(), { recursive: true });
  await writeCoreTo(agentDir, name, options?.description || "A highly capable AI assistant.", options?.template);

  const createdAt = new Date().toISOString();
  const meta: AgentMeta = { name, createdAt, links: [] };
  await initializeAgentMeta(name, meta);

  await updateRegistry((registry) => {
    registry.agents[name] = { createdAt, targets: [] };
    return registry;
  });

  return { name, createdAt, path: agentDir, overwritten };
}

export interface ListedAgent {
  name: string;
  createdAt: string;
  linkedTargets: string[];
  linkedProjects?: string[];
}

export async function listAgents(): Promise<ListedAgent[]> {
  const registry = await readRegistry();
  const agents: ListedAgent[] = [];
  for (const [name, entry] of Object.entries(registry.agents)) {
    if (!agentExists(name)) {
      continue;
    }
    const meta = await getAgentMeta(name);
    const linkedProjects = meta?.links.map((l) => l.projectDir) ?? [];
    const linkedTargets = [...new Set(meta?.links.flatMap((l) => l.targets) ?? [])];
    agents.push({
      name,
      createdAt: entry.createdAt,
      linkedTargets,
      linkedProjects,
    });
  }
  return agents;
}

export interface AgentDeletePlan {
  agent: string;
  agentDir: string;
  projects: Array<{ projectDir: string; targets: string[] }>;
}

export async function getAgentDeletePlan(name: string): Promise<AgentDeletePlan> {
  const agentDir = getAgentDir(name);
  const projectsDirs = await vaultGraph.getProjectsForAgent(name);
  const projects: Array<{ projectDir: string; targets: string[] }> = [];

  for (const projectDir of projectsDirs) {
    const targets = await vaultGraph.getTargetsForAgent(name, projectDir);
    projects.push({ projectDir, targets });
  }

  return {
    agent: name,
    agentDir,
    projects,
  };
}

async function cleanupAgentIntegrations(name: string): Promise<void> {
  const plan = await getAgentDeletePlan(name);

  // Remove target integrations across all linked projects first
  for (const item of plan.projects) {
    if (item.targets.length === 0) continue;
    const linkedAgents = await vaultGraph.getAgentsForProject(item.projectDir);
    const remainingAgents = linkedAgents.filter((a) => a !== name);
    const activeAgent = await vaultGraph.getActiveAgentForProject(item.projectDir);
    const fallbackAgent =
      remainingAgents.length > 0
        ? activeAgent && remainingAgents.includes(activeAgent)
          ? activeAgent
          : remainingAgents[0]
        : undefined;

    try {
      await targetAdapterEngine.removeTargets(name, item.projectDir, item.targets);
      if (fallbackAgent) {
        await targetAdapterEngine.applyTargets(fallbackAgent, item.projectDir, item.targets, {
          rosterAgents: remainingAgents,
          activeAgent: fallbackAgent,
          force: true,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to clean up target integrations for project "${item.projectDir}": ${msg}`);
    }
  }

  // Update graph state last
  for (const item of plan.projects) {
    await vaultGraph.removeProjectLink(name, item.projectDir);
  }
}

export async function deleteAgent(name: string): Promise<boolean> {
  const agentDir = getAgentDir(name);
  const registry = await readRegistry();
  const hadRegistry = Boolean(registry.agents[name]);
  const hadDir = fs.existsSync(agentDir);

  if (!hadDir && !hadRegistry) {
    return false;
  }

  await cleanupAgentIntegrations(name);

  // Delete vault directory & registry entry last
  if (hadDir) {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
  if (hadRegistry) {
    await updateRegistry((registry) => {
      delete registry.agents[name];
      return registry;
    });
  }
  return true;
}

export function getAgentPath(name: string): string {
  return getAgentDir(name);
}

export function normalizeAgentName(rawName: string): string {
  if (!rawName || typeof rawName !== "string") {
    return "";
  }
  const clean = rawName.startsWith("@") ? rawName.slice(1) : rawName;
  return clean.toLowerCase().replace(SANITIZE_PATTERN, "");
}

export function validateAgentName(rawName: string): string {
  if (!rawName || typeof rawName !== "string") {
    throw new Error("Invalid agent name: name cannot be empty.");
  }
  if (rawName.includes("/") || rawName.includes("\\") || rawName.includes("..")) {
    throw new Error(`Invalid agent name "${rawName}": path traversal characters are not allowed.`);
  }
  const normalized = normalizeAgentName(rawName);
  if (!normalized || !NAME_PATTERN.test(normalized)) {
    throw new Error(`Invalid agent name "${rawName}": name contains no valid characters.`);
  }
  return normalized;
}

export function agentExists(name: string): boolean {
  return fs.existsSync(getAgentDir(name));
}
