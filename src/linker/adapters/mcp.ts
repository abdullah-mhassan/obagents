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
    if (entry.command === expectedCommand && JSON.stringify(entry.args) === JSON.stringify(expectedArgs)) {
      return { status: "in-sync" };
    }
    return { status: "drifted", diff: `MCP server "${serverName}" configuration mismatch` };
  },
};

export const serversAdapter: McpConfigAdapter = {
  inject(config, serverName, command, args) {
    config.servers = config.servers || {};
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
    if (entry.type === "stdio" && entry.command === expectedCommand && JSON.stringify(entry.args) === JSON.stringify(expectedArgs)) {
      return { status: "in-sync" };
    }
    return { status: "drifted", diff: `MCP server "${serverName}" configuration mismatch` };
  },
};

export const opencodeAdapter: McpConfigAdapter = {
  inject(config, serverName, command, args) {
    config.mcp = config.mcp || {};
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
      entry.type === "local" &&
      entry.cwd === "." &&
      JSON.stringify(entry.command) === JSON.stringify([expectedCommand, ...expectedArgs])
    ) {
      return { status: "in-sync" };
    }
    return { status: "drifted", diff: `MCP server "${serverName}" configuration mismatch` };
  },
};

export const arrayAdapter: McpConfigAdapter = {
  inject(config, serverName, command, args) {
    config.mcpServers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
    const existingIndex = config.mcpServers.findIndex((s: any) => s.name === serverName);
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
      const index = config.mcpServers.findIndex((s: any) => s.name === serverName);
      if (index >= 0) {
        config.mcpServers.splice(index, 1);
      }
    }
    return config;
  },
  checkRegistration(config: unknown, serverName: string, expectedCommand: string, expectedArgs: string[]) {
    const c = (config && typeof config === "object" ? config : {}) as Record<string, any>;
    const list = c.mcpServers;
    const entry = Array.isArray(list) ? list.find((s: any) => s.name === serverName) : undefined;
    if (!entry) return { status: "missing" };
    if (entry.type === "stdio" && entry.command === expectedCommand && JSON.stringify(entry.args) === JSON.stringify(expectedArgs)) {
      return { status: "in-sync" };
    }
    return { status: "drifted", diff: `MCP server "${serverName}" configuration mismatch` };
  },
};

export const adapters: Record<string, McpConfigAdapter> = {
  mcpServers: mcpServersAdapter,
  servers: serversAdapter,
  opencode: opencodeAdapter,
  array: arrayAdapter,
};
