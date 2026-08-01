import { getAgentMeta, updateAgentMeta as updateAgentMetaStore, type AgentMeta } from "./metadata.js";
import { projectVault, normalizeProjectPath, type ProjectConfig } from "./project.js";
import { type SupportedTarget } from "../utils/constants.js";

/**
 * The agent ↔ project ↔ target link graph, in one module.
 *
 * A link edge is stored on the agent side (`AgentMeta.links`) and on the
 * project side (`ProjectConfig.linkedAgents` / `activeAgent`). This module
 * owns both writes so the invariant — an agent is linked to a project iff
 * the project lists that agent — lives in a single place.
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

  async link(
    agent: string,
    targets: SupportedTarget[] | string[],
    projectDir: string,
    options: { replace?: boolean } = {},
  ): Promise<void> {
    const normProject = normalizeProjectPath(projectDir);
    const validTargets = targets as SupportedTarget[];

    await this.updateProjectConfig(normProject, (config) => {
      const linkedAgents = [...new Set([...config.linkedAgents, agent])];
      const activeAgent = config.activeAgent ?? agent;
      return { ...config, linkedAgents, activeAgent };
    });

    await this.updateAgentMeta(agent, (meta) => {
      const existingLink = meta.links.find(
        (l) => l.projectDir === normProject
      );
      if (existingLink) {
        existingLink.targets = options.replace
          ? ([...new Set(validTargets)] as SupportedTarget[])
          : ([...new Set([...existingLink.targets, ...validTargets])] as SupportedTarget[]);
      } else {
        meta.links.push({
          projectDir: normProject,
          targets: [...new Set(validTargets)] as SupportedTarget[],
        });
      }
      return meta;
    });
  }

  async unlink(
    agent: string,
    targets: SupportedTarget[] | string[],
    projectDir: string,
    options: { keepProject?: boolean } = {},
  ): Promise<void> {
    const normProject = normalizeProjectPath(projectDir);
    const removeTargets = targets as SupportedTarget[];

    await this.updateAgentMeta(agent, (meta) => {
      const existingLinkIndex = meta.links.findIndex(
        (l) => l.projectDir === normProject
      );
      if (existingLinkIndex >= 0) {
        const existingLink = meta.links[existingLinkIndex];
        if (existingLink) {
          if (removeTargets.length === 0) {
            meta.links.splice(existingLinkIndex, 1);
          } else {
            const remaining = existingLink.targets.filter(
              (t) => !removeTargets.includes(t)
            );
            if (remaining.length === 0) {
              meta.links.splice(existingLinkIndex, 1);
            } else {
              existingLink.targets = remaining;
            }
          }
        }
      }
      return meta;
    });

    const remainingTargets = await this.getTargetsForAgent(agent, normProject);

    if (!options.keepProject && remainingTargets.length === 0) {
      await this.updateProjectConfig(normProject, (config) => {
        const linkedAgents = config.linkedAgents.filter((a) => a !== agent);
        const activeAgent = config.activeAgent === agent ? undefined : config.activeAgent;
        return { ...config, linkedAgents, activeAgent };
      });
    }
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

