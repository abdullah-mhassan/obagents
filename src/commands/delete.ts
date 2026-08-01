import { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import { deleteAgent, getAgentDeletePlan, agentExists } from "../vault/agent.js";
import { logger } from "../utils/logger.js";
import { sanitizeName } from "./create.js";
import { runCommand, selectAgent, fail } from "./runner.js";

export function createDeleteCommand(): Command {
  const command = new Command("delete");

  command
    .description("Delete an agent from the Vault.")
    .argument("[name]", "The name of the agent to delete.")
    .option("-y, --yes", "Bypass interactive confirmation prompt")
    .action(
      runCommand(async (providedName: string | undefined, options: { yes?: boolean }) => {
        const name = sanitizeName(providedName ?? (await selectAgent("Select an agent to delete:")));

        if (!agentExists(name)) {
          fail(`Agent "${name}" does not exist.`);
        }

        const plan = await getAgentDeletePlan(name);

        logger.info(`Cleanup Plan for agent "${name}":`);
        logger.info(`  Vault directory: ${plan.agentDir}`);
        if (plan.projects.length > 0) {
          logger.info(`  Linked projects (${plan.projects.length}):`);
          for (const p of plan.projects) {
            const targetsStr = p.targets.length > 0 ? p.targets.join(", ") : "none";
            logger.info(`    - ${p.projectDir} [targets: ${targetsStr}]`);
          }
        } else {
          logger.info(`  Linked projects: none`);
        }

        if (!options.yes) {
          const confirmed = await confirm({
            message: `Are you sure you want to delete agent "${name}"?`,
            default: false,
          });
          if (!confirmed) {
            logger.info("Deletion cancelled.");
            return;
          }
        }

        const deleted = await deleteAgent(name);
        if (!deleted) {
          fail(`Agent "${name}" does not exist.`);
        }

        logger.success(`Deleted agent "${name}".`);
      }),
    );

  return command;
}
