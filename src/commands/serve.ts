import { Command } from "commander";
import { startGatewayMcpServer } from "../mcp/server.js";
import { logger } from "../utils/logger.js";
import { runCommand } from "./runner.js";

export function createServeCommand(): Command {
  const command = new Command("serve");

  command
    .description("Run the MCP Hive gateway (Active Layer) for a project.")
    .option("-p, --project <path>", "Project directory to resolve the Hive from (default: current directory).")
    .action(
      runCommand(async (options: { project?: string }) => {
        const projectDir = options.project ?? process.cwd();
        logger.info(`Starting OB Agents Hive gateway (project: ${projectDir})...`);
        await startGatewayMcpServer(projectDir);
      }),
    );

  return command;
}
