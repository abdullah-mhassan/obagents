import { logger } from "../../utils/logger.js";

export function isStaleObagentsKey(key: string): boolean {
  return key.startsWith("obagents-");
}

export function isLegacyMyagentKey(key: string): boolean {
  return key.startsWith("myagent-");
}

export interface McpConfigAdapter {
  inject(config: any, serverName: string, command: string, args: string[]): any;
  retract(config: any, serverName: string, agentName: string): any;
  checkRegistration(
    config: unknown,
    serverName: string,
    expectedCommand: string,
    expectedArgs: string[],
  ): { status: "in-sync" | "drifted" | "missing"; diff?: string };
}

export const mcpServersAdapter: McpConfigAdapter = {
  inject(config, serverName, command, args) {
    config.mcpServers = config.mcpServers || {};
    for (const key of Object.keys(config.mcpServers)) {
      if (isStaleObagentsKey(key)) {
        delete config.mcpServers[key];
      } else if (isLegacyMyagentKey(key)) {
        logger.warning(`Legacy MCP entry "${key}" detected in configuration. Preserving entry.`);
      }
    }
    config.mcpServers[serverName] = { command, args };
    return config;
  },
  retract(config, serverName) {
    if (config.mcpServers && config.mcpServers[serverName]) {
      delete config.mcpServers[serverName];
    }
    return config;
  },
  checkRegistration(config: unknown, serverName: string, expectedCommand: string, expectedArgs: string[]) {
    const c = (config && typeof config === "object" ? config : {}) as Record<string, any>;
    const entry = c.mcpServers?.[serverName];
    if (!entry) return { status: "missing" };
    if (!(entry.command === expectedCommand && JSON.stringify(entry.args) === JSON.stringify(expectedArgs))) {
      return { status: "drifted", diff: `MCP server "${serverName}" configuration mismatch` };
    }
    if (c.mcpServers && typeof c.mcpServers === "object") {
      for (const key of Object.keys(c.mcpServers)) {
        if (isStaleObagentsKey(key)) {
          return { status: "drifted", diff: `Stale per-agent MCP entry "${key}" present` };
        }
      }
    }
    return { status: "in-sync" };
  },
};

export const serversAdapter: McpConfigAdapter = {
  inject(config, serverName, command, args) {
    config.servers = config.servers || {};
    for (const key of Object.keys(config.servers)) {
      if (isStaleObagentsKey(key)) {
        delete config.servers[key];
      } else if (isLegacyMyagentKey(key)) {
        logger.warning(`Legacy MCP entry "${key}" detected in configuration. Preserving entry.`);
      }
    }
    config.servers[serverName] = {
      type: "stdio",
      command,
      args,
    };
    return config;
  },
  retract(config, serverName) {
    if (config.servers && config.servers[serverName]) {
      delete config.servers[serverName];
    }
    return config;
  },
  checkRegistration(config: unknown, serverName: string, expectedCommand: string, expectedArgs: string[]) {
    const c = (config && typeof config === "object" ? config : {}) as Record<string, any>;
    const entry = c.servers?.[serverName];
    if (!entry) return { status: "missing" };
    if (
      !(
        entry.type === "stdio" &&
        entry.command === expectedCommand &&
        JSON.stringify(entry.args) === JSON.stringify(expectedArgs)
      )
    ) {
      return { status: "drifted", diff: `MCP server "${serverName}" configuration mismatch` };
    }
    if (c.servers && typeof c.servers === "object") {
      for (const key of Object.keys(c.servers)) {
        if (isStaleObagentsKey(key)) {
          return { status: "drifted", diff: `Stale per-agent MCP entry "${key}" present` };
        }
      }
    }
    return { status: "in-sync" };
  },
};

export const opencodeAdapter: McpConfigAdapter = {
  inject(config, serverName, command, args) {
    config.mcp = config.mcp || {};
    for (const key of Object.keys(config.mcp)) {
      if (isStaleObagentsKey(key)) {
        delete config.mcp[key];
      } else if (isLegacyMyagentKey(key)) {
        logger.warning(`Legacy MCP entry "${key}" detected in configuration. Preserving entry.`);
      }
    }
    config.mcp[serverName] = {
      type: "local",
      command: [command, ...args],
      cwd: ".",
    };
    return config;
  },
  retract(config, serverName, _agentName) {
    if (config.mcp && config.mcp[serverName]) {
      delete config.mcp[serverName];
    }
    return config;
  },
  checkRegistration(config: unknown, serverName: string, expectedCommand: string, expectedArgs: string[]) {
    const c = (config && typeof config === "object" ? config : {}) as Record<string, any>;
    const entry = c.mcp?.[serverName];
    if (!entry) return { status: "missing" };
    if (
      !(
        entry.type === "local" &&
        entry.cwd === "." &&
        JSON.stringify(entry.command) === JSON.stringify([expectedCommand, ...expectedArgs])
      )
    ) {
      return { status: "drifted", diff: `MCP server "${serverName}" configuration mismatch` };
    }
    if (c.mcp && typeof c.mcp === "object") {
      for (const key of Object.keys(c.mcp)) {
        if (isStaleObagentsKey(key)) {
          return { status: "drifted", diff: `Stale per-agent MCP entry "${key}" present` };
        }
      }
    }
    return { status: "in-sync" };
  },
};

export const arrayAdapter: McpConfigAdapter = {
  inject(config, serverName, command, args) {
    const list = Array.isArray(config.mcpServers) ? config.mcpServers : [];
    const remaining: any[] = [];
    for (const item of list) {
      const name = item?.name;
      if (typeof name === "string" && isStaleObagentsKey(name)) {
        continue;
      }
      if (typeof name === "string" && isLegacyMyagentKey(name)) {
        logger.warning(`Legacy MCP entry "${name}" detected in configuration. Preserving entry.`);
      }
      remaining.push(item);
    }
    config.mcpServers = remaining;
    const existingIndex = config.mcpServers.findIndex((s: any) => s?.name === serverName);
    const newServer = {
      name: serverName,
      type: "stdio",
      command,
      args,
    };
    if (existingIndex >= 0) {
      config.mcpServers[existingIndex] = newServer;
    } else {
      config.mcpServers.push(newServer);
    }
    return config;
  },
  retract(config, serverName) {
    if (Array.isArray(config.mcpServers)) {
      const index = config.mcpServers.findIndex((s: any) => s?.name === serverName);
      if (index >= 0) {
        config.mcpServers.splice(index, 1);
      }
    }
    return config;
  },
  checkRegistration(config: unknown, serverName: string, expectedCommand: string, expectedArgs: string[]) {
    const c = (config && typeof config === "object" ? config : {}) as Record<string, any>;
    const list = c.mcpServers;
    if (!Array.isArray(list)) return { status: "missing" };
    const entry = list.find((s: any) => s?.name === serverName);
    if (!entry) return { status: "missing" };
    if (
      !(
        entry.type === "stdio" &&
        entry.command === expectedCommand &&
        JSON.stringify(entry.args) === JSON.stringify(expectedArgs)
      )
    ) {
      return { status: "drifted", diff: `MCP server "${serverName}" configuration mismatch` };
    }
    for (const item of list) {
      const name = item?.name;
      if (typeof name === "string" && isStaleObagentsKey(name)) {
        return { status: "drifted", diff: `Stale per-agent MCP entry "${name}" present` };
      }
    }
    return { status: "in-sync" };
  },
};

export const adapters: Record<string, McpConfigAdapter> = {
  mcpServers: mcpServersAdapter,
  servers: serversAdapter,
  opencode: opencodeAdapter,
  array: arrayAdapter,
};

