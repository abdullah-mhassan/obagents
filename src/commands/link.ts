import { Command } from "commander";
import { checkbox } from "@inquirer/prompts";
import { vaultSyncEngine, listSupportedTargets, RollbackFailedError } from "../vault/sync.js";
import { sanitizeName } from "./create.js";
import { logger } from "../utils/logger.js";
import { runCommand, selectAgent, fail } from "./runner.js";

export function createLinkCommand(): Command {
  const command = new Command("link");

  const supported = listSupportedTargets().join(", ");

  command
    .description("Inject the compiled agent configuration into the target tool's settings in the current directory.")
    .argument("[agent]", "The name of the agent to link.")
    .option("-t, --target <tool>", `Specific tool to target (${supported}). If omitted, prompts interactively.`)

    .option("--dry-run", "Show what would be written without making changes.", false)
    .option("-f, --force", "Overwrite conflicting non-OB Agents content.", false)
    .option("--replace", "Replace existing target set instead of unioning.", false)
    .action(
      runCommand(async (providedAgent: string | undefined, options: { target?: string; dryRun?: boolean; force?: boolean; replace?: boolean }) => {
        const agent = sanitizeName(providedAgent ?? (await selectAgent("Select an agent to link:")));

        let targets: string[] | undefined = undefined;
        if (!options.target) {
          targets = await checkbox({
            message: "Select target tools to link:",
            choices: listSupportedTargets().map((t) => ({ name: t, value: t })),
          });
          if (targets.length === 0) {
            fail("No targets selected.");
          }
        }

        try {
          const outcome = await vaultSyncEngine.linkAgent(agent, {
            targets: targets || (options.target ? [options.target] : []),
            dryRun: options.dryRun,
            force: options.force,
            replace: options.replace,
          });
          for (const warning of outcome.warnings) {
            logger.warning(warning);
          }
          for (const { key, result } of outcome.results) {
            if (options.dryRun) {
              logger.info(`[dry-run] ${key}: would ${result.action} ${result.filePath}`);
            } else {
              logger.success(`Linked ${agent} to ${key} (${result.action})`);
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
