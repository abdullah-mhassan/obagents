import { Command } from "commander";
import { logger } from "../utils/logger.js";
import { runCommand } from "./runner.js";
import { installGateway, uninstallGateway, getGatewayStatus } from "../linker/gateway.js";

export function createGatewayCommand(): Command {
  const gateway = new Command("gateway")
    .description("Manage global MCP registration for OB Agents Gateway.");

  gateway
    .command("install")
    .description("Ensure user-level MCP entries across all global-capable tools.")
    .option("--dry-run", "Show what would be installed without making changes.", false)
    .action(
      runCommand(async (options: { dryRun?: boolean }) => {
        const { installed, errors } = await installGateway({ dryRun: options.dryRun });
        for (const target of installed) {
          if (options.dryRun) {
            logger.info(`[dry-run] gateway install: would register obagents in ${target}`);
          } else {
            logger.success(`Gateway registered obagents in ${target}`);
          }
        }
        if (errors.length > 0) {
          for (const err of errors) {
            logger.warning(err);
          }
        }
      }),
    );

  gateway
    .command("status")
    .description("List registration status of OB Agents Gateway across supported tools.")
    .option("-p, --project <path>", "Project directory to inspect for project-only tools.")
    .action(
      runCommand(async (options: { project?: string }) => {
        const items = await getGatewayStatus(options.project);
        for (const item of items) {
          const scopeLabel = item.global ? "global" : "project";
          if (item.status === "registered") {
            logger.success(`  ${item.name} (${item.key}): registered [${scopeLabel}]`);
          } else {
            logger.warning(`  ${item.name} (${item.key}): missing [${scopeLabel}]`);
          }
        }
      }),
    );

  gateway
    .command("uninstall")
    .description("Remove user-level MCP entries across all global-capable tools.")
    .option("--dry-run", "Show what would be uninstalled without making changes.", false)
    .action(
      runCommand(async (options: { dryRun?: boolean }) => {
        const { uninstalled, errors } = await uninstallGateway({ dryRun: options.dryRun });
        for (const target of uninstalled) {
          if (options.dryRun) {
            logger.info(`[dry-run] gateway uninstall: would remove obagents from ${target}`);
          } else {
            logger.success(`Gateway removed obagents from ${target}`);
          }
        }
        if (errors.length > 0) {
          for (const err of errors) {
            logger.warning(err);
          }
        }
      }),
    );

  return gateway;
}
