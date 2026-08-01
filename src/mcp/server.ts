import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "../utils/constants.js";
import { registerTools } from "./index.js";
import { createGatewayContext } from "./gateway.js";

import { fs } from "../utils/fs.js";

const GATEWAY_INSTRUCTIONS = `OB Agents Hive Gateway. You are operating in a multi-agent environment managed by OB Agents. This server serves the Hive of a resolved Project: by default the directory this server was started in, overridable via the \`project\` argument on any tool call. The Active Runtime Agent of the resolved Project is the default target for memory tools; to address any other Roster agent pass \`targetAgent\` WITHOUT the leading '@' (e.g. targetAgent: "odba"). Tools reject agents not linked to the resolved Project.`;

export function createGatewayMcpServer(startupProject: string): McpServer {
  if (!fs.existsSync(startupProject)) {
    throw new Error(`Project directory "${startupProject}" does not exist on disk.`);
  }

  const context = createGatewayContext(startupProject);

  const server = new McpServer(
    { name: "obagents", version: VERSION },
    { instructions: GATEWAY_INSTRUCTIONS },
  );

  registerTools(server, "", { projectDir: startupProject, resolveGateway: context.resolve });

  return server;
}

export async function startGatewayMcpServer(startupProject: string): Promise<void> {
  const server = createGatewayMcpServer(startupProject);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
