import { dirname } from "node:path";
import { logger } from "../utils/logger.js";
import { fs } from "../utils/fs.js";
import { adapters, isStaleObagentsKey, isLegacyMyagentKey } from "./adapters/mcp.js";

export type McpFormat = "mcpServers" | "servers" | "array" | "opencode";

export interface McpInjectionOptions {
  agentName: string;
  projectDir: string;
  configPath: string;
  format: McpFormat;
  action: "link" | "unlink";
  dryRun?: boolean;
  command?: string;
  args?: string[];
  serverName?: string;
}

import { parse as parseJsoncWithErrors, parseTree, modify, applyEdits, type ParseError, type Node } from "jsonc-parser";

export function parseJsonc(raw: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parseJsoncWithErrors(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Parse error in JSONC content: error code ${errors[0]!.error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JSONC structure: expected an object");
  }
  return parsed as Record<string, unknown>;
}

export function resolveBinaryCommand(): string {
  if (process.env.OBAGENTS_BIN) {
    return process.env.OBAGENTS_BIN;
  }
  const arg1 = process.argv[1];
  if (arg1) {
    if (arg1.endsWith("/ob") || arg1.endsWith("\\ob") || arg1.endsWith("/obagents") || arg1.endsWith("\\obagents")) {
      return arg1;
    }
    if (!arg1.endsWith(".js") && !arg1.endsWith(".ts") && !arg1.includes("vitest")) {
      return arg1;
    }
  }
  return "obagents";
}

const formatJsonPathMap: Record<Exclude<McpFormat, "array">, {
  getPath: (name: string) => string[];
  getValue: (cmd: string, args: string[]) => unknown;
}> = {
  mcpServers: {
    getPath: (name) => ["mcpServers", name],
    getValue: (cmd, args) => ({ command: cmd, args }),
  },
  servers: {
    getPath: (name) => ["servers", name],
    getValue: (cmd, args) => ({ type: "stdio", command: cmd, args }),
  },
  opencode: {
    getPath: (name) => ["mcp", name],
    getValue: (cmd, args) => ({ type: "local", command: [cmd, ...args], cwd: "." }),
  },
};

const JSONC_FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" };

function findArrayNode(raw: string, key: string): Node | undefined {
  const root = parseTree(raw);
  if (!root) return undefined;
  const keyNode = root.children?.find((n) => n.type === "property" && n.children?.[0]?.value === key);
  const arrayNode = keyNode?.children?.[1];
  return arrayNode && arrayNode.type === "array" ? arrayNode : undefined;
}

function findArrayEntryIndex(arrayNode: Node, name: string): number {
  return (arrayNode.children ?? []).findIndex((el: Node) => {
    if (el.type !== "object") return false;
    const nameProp = el.children?.find((p) => p.type === "property" && p.children?.[0]?.value === "name");
    return nameProp?.children?.[1]?.value === name;
  });
}

export async function manageMcpConfig(options: McpInjectionOptions): Promise<void> {
  const { agentName, projectDir, configPath, format, action, dryRun, command, args, serverName: nameOverride } = options;

  let config: Record<string, unknown> = {};
  let rawContent: string | null = null;

  if (fs.existsSync(configPath)) {
    rawContent = await fs.readFile(configPath, "utf8");
    try {
      config = parseJsonc(rawContent);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse MCP configuration file at ${configPath}: ${errMsg}`);
    }
  }

  const serverName = nameOverride || "obagents";
  const serverCommand = command || resolveBinaryCommand();
  // When the caller provides explicit args, leave them untouched. Only when args
  // falls back to the default (not provided) and a projectDir is known do we pin
  // the MCP gateway to that project via --project, so it isn't resolved from the
  // gateway's launch CWD.
  const serverArgs = args || (projectDir ? ["serve", "--project", projectDir] : ["serve"]);

  const adapter = adapters[format];
  if (!adapter) {
    logger.warning(`No MCP config adapter found for format "${format}".`);
    return;
  }

  let updatedConfig: Record<string, unknown>;
  if (action === "link") {
    updatedConfig = adapter.inject(config, serverName, serverCommand, serverArgs);
  } else {
    updatedConfig = adapter.retract(config, serverName, agentName);
  }

  if (!dryRun) {
    await fs.mkdir(dirname(configPath), { recursive: true });

    let writtenWithJsonc = false;
    let skipWrite = false;
    if (rawContent && format in formatJsonPathMap) {
      const formatSpec = formatJsonPathMap[format as keyof typeof formatJsonPathMap];
      const containerKey = format === "mcpServers" ? "mcpServers" : format === "servers" ? "servers" : "mcp";
      let currentContent = rawContent;

      if (action === "link") {
        const root = parseTree(currentContent);
        if (root) {
          const containerNode = root.children?.find((n) => n.type === "property" && n.children?.[0]?.value === containerKey);
          const objNode = containerNode?.children?.[1];
          if (objNode && objNode.type === "object") {
            const staleKeys: string[] = [];
            for (const prop of objNode.children ?? []) {
              const k = prop.children?.[0]?.value;
              if (typeof k === "string") {
                if (isStaleObagentsKey(k)) {
                  staleKeys.push(k);
                } else if (isLegacyMyagentKey(k)) {
                  logger.warning(`Legacy MCP entry "${k}" detected in MCP configuration at ${configPath}. Preserving entry.`);
                }
              }
            }
            for (const k of staleKeys) {
              const edits = modify(currentContent, [containerKey, k], undefined, { formattingOptions: JSONC_FORMATTING });
              currentContent = applyEdits(currentContent, edits);
            }
          }
        }
      }

      const jsonPath = formatSpec.getPath(serverName);
      const newValue = action === "link" ? formatSpec.getValue(serverCommand, serverArgs) : undefined;
      const edits = modify(currentContent, jsonPath, newValue, { formattingOptions: JSONC_FORMATTING });
      const outputText = applyEdits(currentContent, edits);
      await fs.writeFile(configPath, outputText, "utf8");
      writtenWithJsonc = true;
    } else if (rawContent && format === "array") {
      let currentContent = rawContent;

      if (action === "link") {
        const arrayNode = findArrayNode(currentContent, "mcpServers");
        if (arrayNode) {
          const staleIndices: number[] = [];
          (arrayNode.children ?? []).forEach((el: Node, index: number) => {
            if (el.type === "object") {
              const nameProp = el.children?.find((p) => p.type === "property" && p.children?.[0]?.value === "name");
              const nameVal = nameProp?.children?.[1]?.value;
              if (typeof nameVal === "string") {
                if (isStaleObagentsKey(nameVal)) {
                  staleIndices.push(index);
                } else if (isLegacyMyagentKey(nameVal)) {
                  logger.warning(`Legacy MCP entry "${nameVal}" detected in MCP configuration at ${configPath}. Preserving entry.`);
                }
              }
            }
          });

          for (let i = staleIndices.length - 1; i >= 0; i--) {
            const idx = staleIndices[i]!;
            const edits = modify(currentContent, ["mcpServers", idx], undefined, { formattingOptions: JSONC_FORMATTING });
            currentContent = applyEdits(currentContent, edits);
          }
        }
      }

      const arrayNode = findArrayNode(currentContent, "mcpServers");
      if (arrayNode) {
        const index = findArrayEntryIndex(arrayNode, serverName);
        if (index >= 0 || action === "link") {
          const jsonPath = index >= 0 ? ["mcpServers", index] : ["mcpServers", -1];
          const newValue =
            action === "link"
              ? { name: serverName, type: "stdio", command: serverCommand, args: serverArgs }
              : undefined;
          const edits = modify(currentContent, jsonPath, newValue, { formattingOptions: JSONC_FORMATTING });
          const outputText = applyEdits(currentContent, edits);
          await fs.writeFile(configPath, outputText, "utf8");
          writtenWithJsonc = true;
        } else {
          skipWrite = true;
        }
      } else if (action === "unlink") {
        skipWrite = true;
      }
    }

    if (!writtenWithJsonc && !skipWrite) {
      await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2) + "\n", "utf8");
    }

    logger.success(`[MCP] ${action === "link" ? "Added" : "Removed"} ${serverName} in ${configPath}`);
  }
}
