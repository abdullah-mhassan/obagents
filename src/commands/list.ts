import { Command } from "commander";
import chalk from "chalk";
import { listAgents } from "../vault/agent.js";
import { logger } from "../utils/logger.js";
import { runCommand } from "./runner.js";

export function createListCommand(): Command {
  const command = new Command("list");

  command
    .alias("ls")
    .description("List all agents in the Vault.")
    .action(
      runCommand(async () => {
        const agents = await listAgents();

        if (agents.length === 0) {
          logger.info("No agents found. Create one with `obagents create <name>`.");
          return;
        }

        for (const agent of agents) {
          const name = chalk.bold(agent.name);
          const created = chalk.gray(agent.createdAt);
          const targets = agent.linkedTargets?.length
            ? chalk.blue(`[${agent.linkedTargets.join(", ")}]`)
            : chalk.gray("[-]");
          const projects = agent.linkedProjects?.length
            ? chalk.cyan(` projects: [${agent.linkedProjects.join(", ")}]`)
            : chalk.gray(" projects: [-]");
          logger.raw(`  ${name}  ${created}  ${targets}${projects}`);
        }
      }),
    );

  return command;
}