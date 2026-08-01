import { Command } from "commander";
import { agentExists } from "../vault/agent.js";
import { pruneStaleEpisodes } from "../memory/decay.js";
import { rebuildJsonlFromDb, rebuildDbFromJsonl } from "../memory/rebuild.js";
import { generateMemoryTree } from "../memory/tree.js";
import { DEFAULT_TOOL_CALL_RETENTION_DAYS } from "../utils/constants.js";
import { sanitizeName } from "./create.js";
import { logger } from "../utils/logger.js";
import { runCommand, selectAgent, fail, resolveProjectDir } from "./runner.js";

export function createMemoryCommand(): Command {
  const memoryCommand = new Command("memory");
  memoryCommand.description("Manage and maintain agent memory engines, decay policies, and disaster recovery.");

  // Subcommand: prune
  memoryCommand
    .command("prune")
    .description("Prune stale tool-call episodes and superseded memory entries.")
    .argument("[agent]", "The name of the agent.")
    .option("-d, --days <number>", "Retention period in days for tool calls.", String(DEFAULT_TOOL_CALL_RETENTION_DAYS))
    .option("--dry-run", "Preview pruning count without deleting data.")
    .action(
      runCommand(async (providedAgent: string | undefined, options: { days?: string; dryRun?: boolean }) => {
        const agent = sanitizeName(providedAgent ?? (await selectAgent("Select an agent to prune memory for:")));

        if (!agentExists(agent)) {
          fail(`Agent "${agent}" does not exist. Run: obagents create ${agent}`);
        }

        const days = options.days ? parseInt(options.days, 10) : DEFAULT_TOOL_CALL_RETENTION_DAYS;
        if (isNaN(days) || days < 0) {
          fail("Retention days must be a non-negative number.");
        }

        const result = await pruneStaleEpisodes(agent, { days, dryRun: options.dryRun });

        if (options.dryRun) {
          logger.info(
            `[Dry Run] Memory prune preview for agent "${agent}": ${result.prunedToolCalls} stale tool call(s), ${result.prunedSuperseded} superseded memory entry(ies) to prune.`,
          );
        } else {
          logger.success(
            `Pruned memory for agent "${agent}": ${result.prunedToolCalls} stale tool call(s), ${result.prunedSuperseded} superseded memory entry(ies) removed.`,
          );
        }
      }),
    );

  // Subcommand: rebuild-jsonl
  memoryCommand
    .command("rebuild-jsonl")
    .description("Rebuild episodes.jsonl mirror from SQLite state.db.")
    .argument("[agent]", "The name of the agent.")
    .action(
      runCommand(async (providedAgent: string | undefined) => {
        const agent = sanitizeName(providedAgent ?? (await selectAgent("Select an agent to rebuild episodes.jsonl for:")));

        if (!agentExists(agent)) {
          fail(`Agent "${agent}" does not exist. Run: obagents create ${agent}`);
        }

        const count = await rebuildJsonlFromDb(agent);
        logger.success(`Rebuilt episodes.jsonl for agent "${agent}" (${count} episode(s) written).`);
      }),
    );

  // Subcommand: rebuild-db
  memoryCommand
    .command("rebuild-db")
    .description("Rebuild SQLite state.db from episodes.jsonl paper trail.")
    .argument("[agent]", "The name of the agent.")
    .action(
      runCommand(async (providedAgent: string | undefined) => {
        const agent = sanitizeName(providedAgent ?? (await selectAgent("Select an agent to rebuild state.db for:")));

        if (!agentExists(agent)) {
          fail(`Agent "${agent}" does not exist. Run: obagents create ${agent}`);
        }

        const count = rebuildDbFromJsonl(agent);
        logger.success(`Rebuilt state.db for agent "${agent}" (${count} episode(s) restored).`);
      }),
    );

  // Subcommand: tree
  memoryCommand
    .command("tree")
    .description("Generate and output categorized Markdown memory tree (ADR 0005).")
    .argument("[agent]", "The name of the agent.")
    .option("-g, --global", "Target the vault instead of the current project.")
    .option("-p, --project <path>", "Target a specific project.")
    .action(
      runCommand(async (providedAgent: string | undefined, options: { global?: boolean; project?: string }) => {
        const agent = sanitizeName(providedAgent ?? (await selectAgent("Select an agent to output memory tree for:")));

        if (!agentExists(agent)) {
          fail(`Agent "${agent}" does not exist. Run: obagents create ${agent}`);
        }

        const projectDir = await resolveProjectDir(agent, options);
        const tree = generateMemoryTree(agent, { projectDir });
        console.log(tree);
      }),
    );

  return memoryCommand;
}
