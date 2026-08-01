import { resolve } from "node:path";
import { agentExists, validateAgentName } from "../vault/agent.js";
import { vaultSyncEngine } from "../vault/sync.js";

export interface GatewayResolution {
  agent: string;
  projectDir: string;
}

export interface GatewayContext {
  cwd: string;
  resolve(args: { targetAgent?: string; project?: string }): Promise<GatewayResolution>;
}

export function createGatewayContext(cwd: string): GatewayContext {
  return {
    cwd,
    async resolve(args) {
      const projectDir = resolve(args.project ?? cwd);
      const roster = await vaultSyncEngine.getAgentsForProject(projectDir);
      if (roster.length === 0) {
        throw new Error(
          `No agents are linked to project "${projectDir}". Run: obagents link <agent> --target <tool>`,
        );
      }

      let agent: string;
      if (args.targetAgent) {
        agent = validateAgentName(args.targetAgent);
        if (!roster.includes(agent)) {
          throw new Error(
            `Agent "${agent}" is not linked to project "${projectDir}". Linked agents: ${roster.join(", ")}`,
          );
        }
      } else {
        const active = await vaultSyncEngine.getActiveAgentForProject(projectDir);
        agent = active ?? roster[0]!;
      }

      if (!agentExists(agent)) {
        throw new Error(`Agent "${agent}" does not exist. Run: obagents create ${agent}`);
      }

      return { agent, projectDir };
    },
  };
}
