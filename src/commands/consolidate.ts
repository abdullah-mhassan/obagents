import { Command } from "commander";
import { consolidateMemory, checkMemoryOverflow } from "../memory/consolidation.js";
import { agentExists } from "../vault/agent.js";
import { editor } from "@inquirer/prompts";
import { sanitizeName } from "./create.js";
import { logger } from "../utils/logger.js";
import { runCommand, selectAgent, fail, resolveProjectDir } from "./runner.js";

export function createConsolidateCommand(): Command {
  const command = new Command("consolidate");

  command
    .description(
      "Archive the agent's current MEMORY.md as an episode in long-term memory and replace it with a summary.",
    )
    .argument("[agent]", "The name of the agent to consolidate.")
    .option("-s, --summary <text>", "The summary text that will replace MEMORY.md.")
    .option("--tags <tags>", "Comma-separated tags for the archived episode.", undefined)
    .option("-g, --global", "Target the vault instead of the current project.")
    .option("-p, --project <path>", "Target a specific project.")
    .action(
      runCommand(async (providedAgent: string | undefined, options: { summary?: string; tags?: string; global?: boolean; project?: string }) => {
        const agent = sanitizeName(providedAgent ?? (await selectAgent("Select an agent to consolidate:")));

        if (!agentExists(agent)) {
          fail(`Agent "${agent}" does not exist. Run: obagents create ${agent}`);
        }

        const projectDir = await resolveProjectDir(agent, options);

        let summary = options.summary;
        if (summary === undefined) {
          summary = await editor({
            message: "Please write a concise summary to replace the current MEMORY.md:",
          });
        }

        if (!summary || summary.trim().length === 0) {
          fail("A summary is required to consolidate memory.");
        }

        const needsConsolidation = await checkMemoryOverflow(agent, projectDir);
        if (needsConsolidation) {
          logger.warning(
            "Agent memory contains enough unconsolidated entries or redundant near-duplicates to warrant consolidation; archiving MEMORY.md and replacing it with the provided summary.",
          );
        }

        const tags = options.tags
          ? options.tags.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined;

        const outcome = await consolidateMemory(agent, summary, { tags, projectDir });
        logger.success(
          `Consolidated agent "${agent}". Archived ${outcome.archivedContent.length} characters as episode #${outcome.episodeId}. MEMORY.md replaced with summary.`,
        );
      }),
    );

  return command;
}