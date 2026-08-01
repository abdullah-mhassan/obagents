import { Command } from "commander";
import { vaultSyncEngine } from "../vault/sync.js";
import { sanitizeName } from "./create.js";
import { logger } from "../utils/logger.js";
import { runCommand, selectAgent, fail } from "./runner.js";

export function createSyncCommand(): Command {
  const command = new Command("sync");

  command
    .description("Re-link an agent into every project registered in its linkedProjects.")
    .argument("[agent]", "The name of the agent to sync.")
    .option("--dry-run", "Show what would be written without making changes.", false)
    .action(
      runCommand(async (providedAgent: string | undefined, options: { dryRun?: boolean }) => {
        const agent = sanitizeName(providedAgent ?? (await selectAgent("Select an agent to sync:")));

        const report = await vaultSyncEngine.syncAgentAcrossProjects(agent, { dryRun: options.dryRun });

        switch (report.status) {
          case "not-found":
            fail(`Agent "${agent}" does not exist. Run: obagents create ${agent}`);
            break;
          case "not-linked":
            logger.info(`Agent "${agent}" is not linked to any projects.`);
            return;
          case "no-targets":
            logger.warning(`Agent "${agent}" has no linked targets to sync.`);
            return;
          case "success":
            for (const projectOutcome of report.projects) {
              for (const { target, result } of projectOutcome.results) {
                if (options.dryRun) {
                  logger.info(`[dry-run] ${projectOutcome.projectDir}: would ${result.action} ${target}`);
                } else {
                  logger.success(`Synced ${agent} -> ${target} in ${projectOutcome.projectDir}`);
                }
              }
            }
            logger.success(`${options.dryRun ? "Would sync" : "Synced"} ${agent} across ${report.syncedCount} project(s).`);
            break;
        }
      }),
    );

  return command;
}
