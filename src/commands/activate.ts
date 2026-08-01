import { Command } from "commander";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";
import { select } from "@inquirer/prompts";
import { sanitizeName } from "./create.js";
import { vaultSyncEngine } from "../vault/sync.js";
import { runCommand, fail } from "./runner.js";

export function createActivateCommand(): Command {
  const command = new Command("activate");

  command
    .description("Set the active runtime agent for the Hive in the current project.")
    .argument("[agent]", "The name of the agent to activate.")
    .option("-p, --project <path>", "Path to the project (default: current directory)")
    .action(
      runCommand(async (providedAgent: string | undefined, options: { project?: string }) => {
        const projectDir = resolve(options.project ?? process.cwd());
        const linkedAgents = await vaultSyncEngine.getAgentsForProject(projectDir);

        if (linkedAgents.length === 0) {
          fail("No agents are linked to this project. Run 'obagents link' first.");
        }

        let agentName = providedAgent;
        if (!agentName) {
          agentName = await select({
            message: "Select an agent to activate:",
            choices: linkedAgents.map((a) => ({ name: a, value: a })),
          });
        }

        agentName = sanitizeName(agentName);
        if (!linkedAgents.includes(agentName)) {
          fail(`Agent "${agentName}" is not linked to this project.`);
        }

        await vaultSyncEngine.activateAgent(agentName, projectDir);

        logger.success(`Activated agent "${agentName}" for Hive routing.`);
      }),
    );

  return command;
}
