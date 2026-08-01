import { Command } from "commander";
import { resolve } from "node:path";
import { checkbox } from "@inquirer/prompts";
import { listSupportedTargets, vaultSyncEngine, RollbackFailedError } from "../vault/sync.js";
import { sanitizeName } from "./create.js";
import { logger } from "../utils/logger.js";
import { runCommand, selectAgent, fail } from "./runner.js";

export function createUnlinkCommand(): Command {
  const command = new Command("unlink");

  const supported = listSupportedTargets().join(", ");

  command
    .description("Remove the agent's configuration from the target tool's settings in the current directory.")
    .argument("[agent]", "The name of the agent to unlink.")
    .option("-t, --target <tool>", `Specific tool to unlink from (${supported}).`)
    .option("--all", "Unlink from every target this agent is currently linked to in the current project.", false)

    .option("--dry-run", "Show what would be cleaned without making changes.", false)
    .action(
      runCommand(async (providedAgent: string | undefined, options: { target?: string; all?: boolean; dryRun?: boolean }) => {
        const agent = sanitizeName(providedAgent ?? (await selectAgent("Select an agent to unlink:")));

        if (options.target && options.all) {
          fail("--target and --all are mutually exclusive.");
        }

        let targets: string[];
        if (options.target) {
          targets = [options.target];
        } else if (options.all) {
          const projectDir = resolve(process.cwd());
          targets = await vaultSyncEngine.getTargetsForAgent(agent, projectDir);
          if (targets.length === 0) {
            fail(`Agent "${agent}" has no linked targets to unlink.`);
          }
        } else {
          const selected = await checkbox({
            message: "Select target tools to unlink:",
            choices: listSupportedTargets().map((t) => ({ name: t, value: t })),
          });
          if (selected.length === 0) {
            fail("No targets selected.");
          }
          targets = selected;
        }

        try {
          const outcome = await vaultSyncEngine.unlinkAgent(agent, {
            targets,
            dryRun: options.dryRun,
          });

          for (const { key } of outcome.results) {
            if (options.dryRun) {
              logger.info(`[dry-run] ${key}: would clean`);
            } else {
              logger.success(`Unlinked ${agent} from ${key}`);
            }
          }
        } catch (err) {
          if (err instanceof RollbackFailedError) {
            fail(err.message);
          }
          throw err;
        }
      }),
    );

  return command;
}

