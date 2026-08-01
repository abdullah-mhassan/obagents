import { Command } from "commander";
import { existsSync } from "node:fs";
import { input } from "@inquirer/prompts";
import { NAME_PATTERN, MAX_AGENTS } from "../utils/constants.js";
import { logger } from "../utils/logger.js";
import { createAgent, listAgents, normalizeAgentName } from "../vault/agent.js";
import { ARCHETYPE_NAMES, resolveTemplateDir } from "../vault/triad.js";
import { runCommand, fail } from "./runner.js";

export function createCreateCommand(): Command {
  const command = new Command("create");

  command
    .description("Initialize a new agent in the Vault.")
    .argument("[name]", "The name of the agent (matches ^[a-z0-9-_]+$).")
    .option("-f, --force", "Overwrite the agent if it already exists.", false)
    .option(
      "-t, --template <name|path>",
      `Path to a directory containing SOUL.md, MEMORY.md, and USER.md templates, or a built-in archetype name (${ARCHETYPE_NAMES.join(", ")}).`,
    )
    .option("-d, --description <text>", "One-line description of the agent.", "")
    .action(
      runCommand(async (providedName: string | undefined, options: { force: boolean; template?: string; description?: string }) => {
        let rawName = providedName;
        if (!rawName) {
          rawName = await input({
            message: "What is the agent's name? (e.g. my-agent)",
          });
        }
        const name = sanitizeName(rawName);

        if (!NAME_PATTERN.test(name)) {
          fail(
            `Invalid agent name "${rawName}". Names may only contain lowercase letters, digits, hyphens, and underscores.`,
          );
        }

        const existing = await listAgents();
        if (existing.length >= MAX_AGENTS && !existing.some((a) => a.name === name)) {
          fail(`Maximum number of agents (${MAX_AGENTS}) reached.`);
        }

        let description = options.description ?? "";
        if (!description && !providedName) {
          description = await input({
            message: "Describe this agent briefly (e.g. A Senior Python Developer):",
          });
        }

        const templateDir = options.template ? resolveTemplateDir(options.template) : undefined;
        if (templateDir && !existsSync(templateDir)) {
          fail(
            `Template directory not found: ${options.template}. Available built-in archetypes: ${ARCHETYPE_NAMES.join(", ")}.`,
          );
        }

        const result = await createAgent(name, { force: options.force, description, template: templateDir });
        if (result.overwritten) {
          logger.warning(`Overwrote existing agent "${result.name}".`);
        }
        logger.success(`Created agent "${result.name}" at ${result.path}`);
      }),
    );

  return command;
}

export function sanitizeName(rawName: string): string {
  return normalizeAgentName(rawName);
}