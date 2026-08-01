import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisterToolsOptions } from "./tools/utils.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerHiveTools } from "./tools/hive.js";

export function registerTools(
  server: McpServer,
  agentName: string,
  options: RegisterToolsOptions = {},
): void {
  // Core self-reflection and memory tools
  registerMemoryTools(server, agentName, options);

  // Advanced Hive orchestration tools
  registerHiveTools(server, agentName, options);
}
