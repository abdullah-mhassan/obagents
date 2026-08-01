import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "../utils/constants.js";
import { agentExists } from "../vault/agent.js";
import { registerTools } from "./index.js";

import { fs } from "../utils/fs.js";

export function createMcpServer(agentName: string, projectDir?: string): McpServer {
  if (!agentExists(agentName)) {
    throw new Error(
      `Agent "${agentName}" does not exist. Run: obagents create ${agentName}`,
    );
  }

  if (projectDir && !fs.existsSync(projectDir)) {
    throw new Error(`Project directory "${projectDir}" does not exist on disk.`);
  }

  const instructions = `Active layer for agent "${agentName}". You are operating in a multi-agent environment managed by OB Agents. If the user @mentions a specific agent, or asks for help from a specific agent, you MUST use the \`load_agent_context\` MCP tool to dynamically retrieve their rules, persona, and memory before responding. Pass the agent name WITHOUT the leading '@' (e.g. targetAgent: "odba").`;

  const server = new McpServer(
    { name: "obagents", version: VERSION },
    { instructions },
  );

  registerTools(server, agentName, { projectDir });

  return server;
}

export async function startMcpServer(agentName: string, projectDir?: string): Promise<void> {
  const server = createMcpServer(agentName, projectDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}