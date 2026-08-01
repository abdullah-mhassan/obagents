import { resolve } from "node:path";
import type { AdapterResult } from "../linker/types.js";
import { targetAdapterEngine, TargetAdapterEngine } from "../linker/engine.js";
import { agentExists } from "./agent.js";
import { vaultGraph, LinkGraph } from "./link-graph.js";
import { projectVault } from "./project.js";
import { SUPPORTED_TARGETS, type SupportedTarget } from "../utils/constants.js";

export interface LinkOptions {
  targets?: string[];
  dryRun?: boolean;
  force?: boolean;
  replace?: boolean;
  projectDir?: string;
}

export interface UnlinkOptions {
  targets?: string[];
  dryRun?: boolean;
  projectDir?: string;
}

export interface LinkOutcome {
  agent: string;
  projectDir: string;
  results: Array<{ target: string; key: string; result: AdapterResult }>;
  warnings: string[];
}

export interface UnlinkOutcome {
  agent: string;
  projectDir: string;
  results: Array<{ target: string; key: string; cleaned: boolean }>;
}

export interface SyncProjectOutcome {
  projectDir: string;
  results: Array<{ target: string; result: AdapterResult }>;
  warnings: string[];
}

export type SyncReport =
  | { status: "not-found"; agent: string }
  | { status: "not-linked"; agent: string }
  | { status: "no-targets"; agent: string }
  | { status: "success"; agent: string; syncedCount: number; projects: SyncProjectOutcome[] };

function validateTarget(target: string): SupportedTarget {
  if (!SUPPORTED_TARGETS.includes(target as SupportedTarget)) {
    throw new Error(
      `Unsupported target "${target}". Supported: ${SUPPORTED_TARGETS.join(", ")}.`,
    );
  }
  return target as SupportedTarget;
}

function resolveTargets(explicitTargets?: string[]): string[] {
  if (explicitTargets && explicitTargets.length > 0) {
    return explicitTargets.map(validateTarget);
  }
  throw new Error(
    `No target specified. Specify --target <tool>. Supported: ${SUPPORTED_TARGETS.join(", ")}.`,
  );
}

export class RollbackFailedError extends Error {
  constructor(
    public readonly originalError: Error,
    public readonly orphanedTargets: string[],
    public readonly projectDir: string,
    public readonly operation: "link" | "unlink" = "link",
  ) {
    const origMsg = originalError.message;
    const targetList = orphanedTargets.join(", ");
    const targetArg = orphanedTargets.join(",");
    const message =
      operation === "link"
        ? `Link failed and automatic rollback also failed. Targets [${targetList}] ` +
          `may have leftover config in ${projectDir}. Run "obagents unlink --target ${targetArg}" ` +
          `to clean up manually, then retry. Original error: ${origMsg}`
        : `Unlink failed and automatic recovery also failed. Targets [${targetList}] ` +
          `may be left in an inconsistent state in ${projectDir} (partially removed or reapplied). ` +
          `Run "obagents diff" to inspect the current state, then "obagents link --target ${targetArg} --force" ` +
          `to restore, or "obagents unlink --target ${targetArg}" to finish cleaning up. Original error: ${origMsg}`;
    super(message);
    this.name = "RollbackFailedError";
  }
}

export class VaultSyncEngine {
  constructor(
    private targetEngine: TargetAdapterEngine = targetAdapterEngine,
    private graph: LinkGraph = vaultGraph,
  ) {}

  async linkAgent(name: string, options: LinkOptions): Promise<LinkOutcome> {
    if (!agentExists(name)) {
      throw new Error(`Agent "${name}" does not exist. Run: obagents create ${name}`);
    }

    const projectDir = resolve(options.projectDir ?? process.cwd());
    const targets = resolveTargets(options.targets);
    const warnings: string[] = [];

    const rosterAgents = await this.getAgentsForProject(projectDir);
    const activeAgent = await this.getActiveAgentForProject(projectDir);

    if (!options.dryRun) {
      await projectVault.ensureProjectMemoryExists(name, projectDir);
    }

    const appliedTargets: string[] = [];
    const results: Array<{ target: string; key: string; result: AdapterResult }> = [];
    try {
      for (const key of targets) {
        const res = await this.targetEngine.applyTargets(name, projectDir, [key], {
          rosterAgents,
          activeAgent,
          dryRun: options.dryRun,
          force: options.force,
        });
        results.push(...res);
        appliedTargets.push(key);
      }
    } catch (err) {
      if (!options.dryRun && appliedTargets.length > 0) {
        try {
          await this.targetEngine.removeTargets(name, projectDir, appliedTargets, { dryRun: false });
        } catch {
          const originalError = err instanceof Error ? err : new Error(String(err));
          throw new RollbackFailedError(originalError, appliedTargets, projectDir);
        }
      }
      throw err;
    }

    if (!options.dryRun) {
      await this.graph.link(name, targets, projectDir, { replace: options.replace });
    }

    return { agent: name, projectDir, results, warnings };
  }

  async unlinkAgent(name: string, options: UnlinkOptions): Promise<UnlinkOutcome> {
    if (!agentExists(name)) {
      throw new Error(`Agent "${name}" does not exist. Run: obagents create ${name}`);
    }

    const projectDir = resolve(options.projectDir ?? process.cwd());
    const targets = resolveTargets(options.targets);

    const linkedAgents = await this.graph.getAgentsForProject(projectDir);
    const remainingAgents = linkedAgents.filter((a) => a !== name);
    const activeAgent = await this.graph.getActiveAgentForProject(projectDir);
    const fallbackAgent =
      remainingAgents.length > 0
        ? activeAgent && remainingAgents.includes(activeAgent)
          ? activeAgent
          : remainingAgents[0]
        : undefined;

    let results: Array<{ target: string; key: string; cleaned: boolean }> = [];
    try {
      for (const key of targets) {
        let otherAgentHasTarget = false;
        for (const remAgent of remainingAgents) {
          const remTargets = await this.graph.getTargetsForAgent(remAgent, projectDir);
          if (remTargets.includes(key as SupportedTarget)) {
            otherAgentHasTarget = true;
            break;
          }
        }
        const removeRes = await this.targetEngine.removeTargets(name, projectDir, [key], {
          dryRun: options.dryRun,
          otherAgentHasTarget,
        });
        results.push(...removeRes);
      }

      if (fallbackAgent) {
        await this.targetEngine.applyTargets(fallbackAgent, projectDir, targets, {
          rosterAgents: remainingAgents,
          activeAgent: fallbackAgent,
          dryRun: options.dryRun,
          force: true,
        });
      }
    } catch (err) {
      if (!options.dryRun) {
        try {
          const rosterAgents = await this.getAgentsForProject(projectDir);
          const currentActiveAgent = await this.getActiveAgentForProject(projectDir);
          await this.targetEngine.applyTargets(name, projectDir, targets, {
            rosterAgents,
            activeAgent: currentActiveAgent,
            dryRun: false,
            force: true,
          });
        } catch {
          const originalError = err instanceof Error ? err : new Error(String(err));
          throw new RollbackFailedError(originalError, targets, projectDir, "unlink");
        }
      }
      throw err;
    }

    if (!options.dryRun) {
      await this.graph.unlink(name, targets, projectDir);
    }

    return { agent: name, projectDir, results };
  }

  async syncAgentAcrossProjects(
    agentName: string,
    options?: { dryRun?: boolean },
  ): Promise<SyncReport> {
    if (!agentExists(agentName)) {
      return { status: "not-found", agent: agentName };
    }

    const projects = await this.getProjectsForAgent(agentName);
    if (projects.length === 0) {
      return { status: "not-linked", agent: agentName };
    }

    const projectOutcomes: SyncProjectOutcome[] = [];
    let syncedCount = 0;

    for (const projectDir of projects) {
      const targets = await this.getTargetsForAgent(agentName, projectDir);
      if (targets.length === 0) {
        continue;
      }

      const outcome = await this.linkAgent(agentName, {
        targets,
        dryRun: options?.dryRun,
        projectDir,
      });

      projectOutcomes.push({
        projectDir,
        results: outcome.results.map((r) => ({ target: r.target, result: r.result })),
        warnings: outcome.warnings,
      });
      syncedCount++;
    }

    if (syncedCount === 0) {
      return { status: "no-targets", agent: agentName };
    }

    return {
      status: "success",
      agent: agentName,
      syncedCount,
      projects: projectOutcomes,
    };
  }

  async activateAgent(name: string, projectDir: string, options?: { dryRun?: boolean }): Promise<void> {
    if (!agentExists(name)) {
      throw new Error(`Agent "${name}" does not exist. Run: obagents create ${name}`);
    }

    const normDir = resolve(projectDir);
    const linkedAgents = await this.getAgentsForProject(normDir);
    if (!linkedAgents.includes(name)) {
      throw new Error(`Agent "${name}" is not linked to this project.`);
    }

    const targets = await this.getTargetsForAgent(name, normDir);
    if (targets.length === 0) {
      throw new Error(
        `Agent "${name}" has no linked targets in this project. ` +
          `Run: obagents link ${name} --target <tool>`,
      );
    }

    await this.targetEngine.applyTargets(name, normDir, targets, {
      rosterAgents: linkedAgents,
      activeAgent: name,
      dryRun: options?.dryRun,
      force: true,
    });

    if (!options?.dryRun) {
      await this.graph.setActiveAgentForProject(normDir, name);
    }
  }

  async getAgentsForProject(projectDir: string): Promise<string[]> {
    return this.graph.getAgentsForProject(projectDir);
  }

  async getTargetsForAgent(name: string, projectDir: string): Promise<SupportedTarget[]> {
    return this.graph.getTargetsForAgent(name, projectDir);
  }

  async getActiveAgentForProject(projectDir: string): Promise<string | undefined> {
    return this.graph.getActiveAgentForProject(projectDir);
  }

  async getProjectsForAgent(name: string): Promise<string[]> {
    return this.graph.getProjectsForAgent(name);
  }
}

export const vaultSyncEngine = new VaultSyncEngine();
export const vaultSync = vaultSyncEngine;
export const VaultSync = VaultSyncEngine;

export function listSupportedTargets(): readonly string[] {
  return SUPPORTED_TARGETS;
}


