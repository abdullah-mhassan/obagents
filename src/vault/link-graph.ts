import { getAgentMeta, updateAgentMeta as updateAgentMetaStore, type AgentMeta } from "./metadata.js";
import { projectVault, normalizeProjectPath, type ProjectConfig } from "./project.js";
import { updateRegistry } from "./registry.js";
import { type SupportedTarget } from "../utils/constants.js";

export type LinkStateAction = "link" | "unlink";

export interface UpdateLinkStateOptions {
  replace?: boolean;
  keepProject?: boolean;
}

/**
 * The agent ↔ project ↔ target link graph, in one module.
 *
 * A link edge is stored on the agent side (`AgentMeta.links`) and on the
 * project side (`ProjectConfig.linkedAgents` / `activeAgent`), as well as
 * tracked in the global registry (`AgentsRegistry`). This module owns all
 * 3 metadata stores so the invariant lives in a single place.
 */
export class LinkGraph {
  private updateAgentMeta(
    name: string,
    patch: (meta: AgentMeta) => AgentMeta | Promise<AgentMeta>
  ): Promise<AgentMeta> {
    return updateAgentMetaStore(name, patch);
  }

  private async updateProjectConfig(
    projectDir: string,
    patch: (config: ProjectConfig) => ProjectConfig | Promise<ProjectConfig>
  ): Promise<ProjectConfig> {
    return projectVault.updateProjectConfig(projectDir, patch);
  }

  /**
   * Atomically updates Registry (`agents.json`), Agent Metadata (`agent.json`),
   * and Project Config (`.obagents-project.json`) with rollback protection.
   */
  async updateLinkState(
    agentName: string,
    projectDir: string,
    targets: SupportedTarget[] | string[],
    action: LinkStateAction,
    options: UpdateLinkStateOptions = {},
  ): Promise<void> {
    const normProject = normalizeProjectPath(projectDir);
    const validTargets = targets as SupportedTarget[];

    const rollbacks: Array<() => Promise<unknown>> = [];

    try {
      if (action === "link") {
        // 1. Update ProjectConfig safely under lock
        let prevProjectConfig: ProjectConfig | undefined;
        await this.updateProjectConfig(normProject, (config) => {
          prevProjectConfig = config;
          const linkedAgents = [...new Set([...config.linkedAgents, agentName])];
          const activeAgent = config.activeAgent ?? agentName;
          return { ...config, linkedAgents, activeAgent };
        });
        rollbacks.push(() => {
          if (prevProjectConfig !== undefined) {
            const restoredConfig = prevProjectConfig;
            return this.updateProjectConfig(normProject, () => restoredConfig);
          }
          return Promise.resolve();
        });

        // 2. Update AgentMeta safely under lock
        let prevAgentMeta: AgentMeta | undefined;
        const nextAgentMeta = await this.updateAgentMeta(agentName, (meta) => {
          prevAgentMeta = meta;
          const currentMeta: AgentMeta = {
            ...meta,
            links: meta.links.map((l) => ({
              projectDir: l.projectDir,
              targets: [...l.targets],
            })),
          };
          const existingLink = currentMeta.links.find(
            (l) => l.projectDir === normProject,
          );
          if (existingLink) {
            existingLink.targets = options.replace
              ? ([...new Set(validTargets)] as SupportedTarget[])
              : ([...new Set([...existingLink.targets, ...validTargets])] as SupportedTarget[]);
          } else {
            currentMeta.links.push({
              projectDir: normProject,
              targets: [...new Set(validTargets)] as SupportedTarget[],
            });
          }
          return currentMeta;
        });
        rollbacks.push(() => {
          if (prevAgentMeta !== undefined) {
            const restoredMeta = prevAgentMeta;
            return this.updateAgentMeta(agentName, () => restoredMeta);
          }
          return Promise.resolve();
        });

        // 3. Update Registry safely under lock
        await updateRegistry((registry) => {
          const existingEntry = registry.agents[agentName];
          const createdAt =
            existingEntry?.createdAt ??
            nextAgentMeta.createdAt ??
            new Date().toISOString();
          const allTargets = [
            ...new Set(nextAgentMeta.links.flatMap((l) => l.targets)),
          ];
          return {
            ...registry,
            agents: {
              ...registry.agents,
              [agentName]: { createdAt, targets: allTargets },
            },
          };
        });
      } else {
        // action === "unlink"
        // 1. Update AgentMeta safely under lock
        let prevAgentMeta: AgentMeta | undefined;
        let remainingTargetsForProject: SupportedTarget[] = [];
        const nextAgentMeta = await this.updateAgentMeta(agentName, (meta) => {
          prevAgentMeta = meta;
          const currentMeta: AgentMeta = {
            ...meta,
            links: meta.links.map((l) => ({
              projectDir: l.projectDir,
              targets: [...l.targets],
            })),
          };
          const existingLinkIndex = currentMeta.links.findIndex(
            (l) => l.projectDir === normProject,
          );
          if (existingLinkIndex >= 0) {
            const existingLink = currentMeta.links[existingLinkIndex];
            if (existingLink) {
              if (validTargets.length === 0) {
                currentMeta.links.splice(existingLinkIndex, 1);
              } else {
                const remaining = existingLink.targets.filter(
                  (t) => !validTargets.includes(t),
                );
                if (remaining.length === 0) {
                  currentMeta.links.splice(existingLinkIndex, 1);
                } else {
                  existingLink.targets = remaining;
                  remainingTargetsForProject = remaining;
                }
              }
            }
          }
          return currentMeta;
        });
        rollbacks.push(() => {
          if (prevAgentMeta !== undefined) {
            const restoredMeta = prevAgentMeta;
            return this.updateAgentMeta(agentName, () => restoredMeta);
          }
          return Promise.resolve();
        });

        // 2. Update ProjectConfig safely under lock if no targets remain
        if (!options.keepProject && remainingTargetsForProject.length === 0) {
          let prevProjectConfig: ProjectConfig | undefined;
          await this.updateProjectConfig(normProject, (config) => {
            prevProjectConfig = config;
            const linkedAgents = config.linkedAgents.filter(
              (a) => a !== agentName,
            );
            const activeAgent =
              config.activeAgent === agentName
                ? undefined
                : config.activeAgent;
            return { ...config, linkedAgents, activeAgent };
          });
          rollbacks.push(() => {
            if (prevProjectConfig !== undefined) {
              const restoredConfig = prevProjectConfig;
              return this.updateProjectConfig(normProject, () => restoredConfig);
            }
            return Promise.resolve();
          });
        }

        // 3. Update Registry safely under lock
        await updateRegistry((registry) => {
          const existingEntry = registry.agents[agentName];
          if (existingEntry) {
            const allTargets = [
              ...new Set(nextAgentMeta.links.flatMap((l) => l.targets)),
            ];
            return {
              ...registry,
              agents: {
                ...registry.agents,
                [agentName]: { ...existingEntry, targets: allTargets },
              },
            };
          }
          return registry;
        });
      }
    } catch (err) {
      for (const rb of rollbacks.reverse()) {
        try {
          await rb();
        } catch {
          // ignore rollback failures to attempt best-effort recovery
        }
      }
      throw err;
    }
  }

  async link(
    agent: string,
    targets: SupportedTarget[] | string[],
    projectDir: string,
    options: { replace?: boolean } = {},
  ): Promise<void> {
    await this.updateLinkState(agent, projectDir, targets, "link", options);
  }

  async unlink(
    agent: string,
    targets: SupportedTarget[] | string[],
    projectDir: string,
    options: { keepProject?: boolean } = {},
  ): Promise<void> {
    await this.updateLinkState(agent, projectDir, targets, "unlink", options);
  }

  async getProjectsForAgent(agent: string): Promise<string[]> {
    const meta = await getAgentMeta(agent);
    return meta?.links.map((l) => l.projectDir) ?? [];
  }

  async getAgentsForProject(projectDir: string): Promise<string[]> {
    const normProject = normalizeProjectPath(projectDir);
    return (await projectVault.getProjectConfig(normProject)).linkedAgents;
  }

  async getTargetsForAgent(agent: string, projectDir: string): Promise<SupportedTarget[]> {
    const normProject = normalizeProjectPath(projectDir);
    const meta = await getAgentMeta(agent);
    const link = meta?.links.find((l) => l.projectDir === normProject);
    return link?.targets ?? [];
  }

  async getActiveAgentForProject(
    projectDir: string,
  ): Promise<string | undefined> {
    const normProject = normalizeProjectPath(projectDir);
    return (await projectVault.getProjectConfig(normProject)).activeAgent;
  }

  async setActiveAgentForProject(
    projectDir: string,
    agent: string | undefined,
  ): Promise<void> {
    const normProject = normalizeProjectPath(projectDir);
    if (agent !== undefined) {
      const config = await projectVault.getProjectConfig(normProject);
      if (!config.linkedAgents.includes(agent)) {
        throw new Error(`Cannot set active agent to "${agent}" because it is not linked to project "${projectDir}".`);
      }
    }
    await this.updateProjectConfig(normProject, (config) => {
      return { ...config, activeAgent: agent };
    });
  }

  async removeProjectLink(agent: string, projectDir: string): Promise<void> {
    await this.unlink(agent, [], projectDir, { keepProject: false });
  }
}

export const linkGraph = new LinkGraph();
export const vaultGraph = linkGraph;
export const VaultGraph = LinkGraph;


