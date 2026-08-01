import { Command } from "commander";
import { diffProject, fixDrift } from "../linker/diff.js";
import { logger } from "../utils/logger.js";
import { runCommand } from "./runner.js";

export function createDiffCommand(): Command {
  const command = new Command("diff");

  command
    .description("Show drift between linked project files and the freshly compiled agent state.")
    .option("-p, --project <path>", "Project directory to inspect. Defaults to the current directory.")
    .option("--fix", "Re-link any drifted or missing targets to bring them back in sync.", false)
    .action(
      runCommand(async (options: { project?: string; fix?: boolean }) => {
        const { projectDir, targets } = await diffProject(options.project);

        if (targets.length === 0) {
          logger.info(`No linked OB Agents targets found in ${projectDir}.`);
          return;
        }

        let drift = 0;
        for (const target of targets) {
          if (target.status === "in-sync") {
            logger.success(`${target.name} (${target.key}) is in sync: ${target.filePath}`);
            continue;
          }

          drift++;
          if (target.status === "missing") {
            logger.warning(`${target.name} (${target.key}) has no OB Agents block: ${target.filePath}`);
            continue;
          }

          logger.warning(`${target.name} (${target.key}) has drifted: ${target.filePath}`);
          if (target.diff) {
            logger.raw(target.diff);
          }
        }

        if (drift === 0) {
          logger.success(`All ${targets.length} linked target(s) in sync.`);
          return;
        }

        if (options.fix) {
          const { fixed } = await fixDrift(options.project);
          for (const key of fixed) {
            logger.success(`Re-linked ${key} back in sync.`);
          }
          logger.success(`Fixed ${fixed.length} target(s).`);
          return;
        }

        logger.info(`${drift} of ${targets.length} target(s) out of sync. Re-run with --fix, or: obagents link`);
        process.exitCode = 1;
      }),
    );

  return command;
}
