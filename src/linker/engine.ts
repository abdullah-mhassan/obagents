import { resolve } from "node:path";
import type { AdapterResult, McpServerConfig, LinkContext, TargetAdapter } from "./types.js";
import { createMapper } from "./mappers/base.js";
import { DESCRIPTORS } from "./mappers/declarations.js";
import { compileRoster } from "../vault/roster.js";
import { compileAgent } from "../vault/compiler.js";
import { projectVault, normalizeProjectPath } from "../vault/project.js";
import type { SupportedTarget } from "../utils/constants.js";

import { resolveBinaryCommand } from "./mcp.js";

export function getAgentMcpConfig(_agentName?: string, _projectDir?: string): McpServerConfig {
  return {
    name: "obagents",
    command: resolveBinaryCommand(),
    args: ["serve"],
  };
}


export interface TargetApplyOptions {
  rosterAgents?: string[];
  activeAgent?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface TargetRemoveOptions {
  dryRun?: boolean;
  otherAgentHasTarget?: boolean;
  forceCleanMcp?: boolean;
}

export interface TargetApplyResult {
  target: string;
  key: string;
  result: AdapterResult;
}

export interface TargetRemoveResult {
  target: string;
  key: string;
  cleaned: boolean;
}

function getDefaultAdapters(): TargetAdapter[] {
  return DESCRIPTORS.map(createMapper);
}

export class TargetAdapterEngine {
  private registry = new Map<SupportedTarget, TargetAdapter>();

  constructor(adapters: TargetAdapter[] = getDefaultAdapters()) {
    for (const adapter of adapters) {
      this.registry.set(adapter.key as SupportedTarget, adapter);
    }
  }

  getAdapter(key: string): TargetAdapter | undefined {
    return this.registry.get(key as SupportedTarget);
  }

  getAdapters(): TargetAdapter[] {
    return Array.from(this.registry.values());
  }

  private createContext(
    agentName: string,
    projectDir: string,
    targets: string[],
    rosterAgents: string[] = [],
    activeAgent?: string,
  ): LinkContext {
    return {
      agentName,
      projectDir,
      targets,
      async getRosterContent() {
        return compileRoster(projectDir, rosterAgents, activeAgent, [agentName]);
      },
      async getPassiveContent() {
        const roster = await compileRoster(projectDir, rosterAgents, activeAgent, [agentName]);
        const compiled = await compileAgent(agentName, projectDir);
        return `${roster}\n\n${compiled.content}`;
      },
      async getAgentMcpConfig(): Promise<McpServerConfig> {
        return getAgentMcpConfig(agentName, projectDir);
      },
    };
  }


  async applyTargets(
    agentName: string,
    projectDir: string,
    targets: string[],
    options?: TargetApplyOptions,
  ): Promise<TargetApplyResult[]> {
    const resolvedDir = resolve(projectDir);
    const context = this.createContext(
      agentName,
      resolvedDir,
      targets,
      options?.rosterAgents,
      options?.activeAgent,
    );
    const results: TargetApplyResult[] = [];

    for (const key of targets) {
      const adapter = this.registry.get(key as SupportedTarget);
      if (!adapter) {
        throw new Error(`No mapper registered for target "${key}".`);
      }
      const result = await adapter.apply(context, {
        dryRun: options?.dryRun,
        force: options?.force,
      });
      results.push({ target: key, key, result });
    }

    return results;
  }

  async removeTargets(
    agentName: string,
    projectDir: string,
    targets: string[],
    options?: TargetRemoveOptions,
  ): Promise<TargetRemoveResult[]> {
    const resolvedDir = resolve(projectDir);
    const context = this.createContext(agentName, resolvedDir, targets);
    const results: TargetRemoveResult[] = [];

    for (const key of targets) {
      const adapter = this.registry.get(key as SupportedTarget);
      if (!adapter) {
        throw new Error(`No mapper registered for target "${key}".`);
      }

      const removeResult = await adapter.remove(context, {
        dryRun: options?.dryRun,
        agentName,
        otherAgentHasTarget: options?.otherAgentHasTarget,
        forceCleanMcp: options?.forceCleanMcp,
      });

      results.push({ target: key, key, cleaned: removeResult.cleaned });
    }

    return results;
  }

  async getExpectedContent(
    agentName: string,
    projectDir: string,
    targetKey: string,
    rosterContext?: { rosterAgents?: string[]; activeAgent?: string },
  ): Promise<{ content: string; mcpConfig?: McpServerConfig }> {
    const resolvedDir = resolve(projectDir);
    const context = this.createContext(
      agentName,
      resolvedDir,
      [targetKey],
      rosterContext?.rosterAgents,
      rosterContext?.activeAgent,
    );
    const adapter = this.registry.get(targetKey as SupportedTarget);
    if (!adapter) {
      throw new Error(`No mapper registered for target "${targetKey}".`);
    }

    const descriptor = DESCRIPTORS.find((d) => d.key === targetKey);
    const isPassive = Boolean(descriptor && "passive" in descriptor && descriptor.passive);
    const content = isPassive ? await context.getPassiveContent() : await context.getRosterContent();
    const mcpConfig =
      descriptor && "mcp" in descriptor && descriptor.mcp
        ? await context.getAgentMcpConfig()
        : undefined;

    return { content: content.trim(), mcpConfig };
  }
}

export const targetAdapterEngine = new TargetAdapterEngine();
