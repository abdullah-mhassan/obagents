import { Command } from "commander";
import { startMcpServer } from "../mcp/server.js";
import { agentExists } from "../vault/agent.js";
import { sanitizeName } from "./create.js";
import { logger } from "../utils/logger.js";
import { runCommand, fail } from "./runner.js";

export function createServeCommand(): Command {
  const command = new Command("serve");

  command
    .description("Run the MCP stdio server for an agent (Active Layer).")
    .argument("<agent>", "The name of the agent to serve.")
    .option("-p, --project <path>", "Project directory to scope memory to (default: current directory).")
    .action(
      runCommand(async (providedAgent: string, options: { project?: string }) => {
        const agent = sanitizeName(providedAgent);
        if (!agentExists(agent)) {
          fail(`Agent "${agent}" does not exist. Run: obagents create ${agent}`);
        }

        const projectDir = options.project ?? process.cwd();
        logger.info(`Starting MCP server for agent "${agent}" (project: ${projectDir})...`);

        await startMcpServer(agent, projectDir);
      }),
    );

  return command;
}