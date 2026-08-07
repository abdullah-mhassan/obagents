import { dirname, join } from "node:path";
import type { MapperWriteOptions, MapperCleanOptions } from "../types.js";
import type { MapperDescriptor } from "./base.js";
import { fs } from "../../utils/fs.js";
import { getClaudeSettingsPath, pathResolver } from "../../utils/paths.js";
import { logger } from "../../utils/logger.js";
import { aiderDescriptor } from "./aider.js";
import { codexMcpArgs, runCodexCapture } from "../codex-cli.js";

import { parseJsonc, resolveBinaryCommand } from "../mcp.js";

type ClaudeSettingsFile = { contextPaths: string[] } & Record<string, unknown>;

async function readClaudeSettings(): Promise<ClaudeSettingsFile> {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { contextPaths: [] };
  }
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = parseJsonc(raw);
    const contextPaths = Array.isArray(parsed.contextPaths)
      ? (parsed.contextPaths as string[])
      : [];
    return { ...parsed, contextPaths };
  } catch {
    return { contextPaths: [] };
  }
}

async function writeClaudeSettings(settings: ClaudeSettingsFile): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  await fs.mkdir(dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

const CURSOR_FRONTMATTER = `---
description: OB Agents injected context
globs: "**/*"
alwaysApply: true
---`;

const OPENCODE_FRONTMATTER = `---
description: OB Agents injected context for OpenCode
alwaysApply: true
---`;

export async function runCodexMcp(
  args: string[],
  cwd: string = process.cwd(),
): Promise<void> {
  await runCodexCapture(args, cwd);
}

export const DESCRIPTORS: MapperDescriptor[] = [
  {
    key: "cursor",
    name: "Cursor",
    relativePath: ".cursor/rules/obagents.mdc",
    frontmatter: CURSOR_FRONTMATTER,
    owned: true,
    mcp: {
      configPath: () => pathResolver.getCursorMcpPath(),
      format: "mcpServers",
    },
  },
  {
    key: "windsurf",
    name: "Windsurf",
    relativePath: ".windsurfrules",
    mcp: {
      configPath: () => pathResolver.getWindsurfMcpPath(),
      format: "mcpServers",
    },
  },
  {
    key: "roo",
    name: "Roo Code",
    relativePath: ".roo/rules/00-obagents.md",
    owned: true,
    mcp: {
      configPath: () => pathResolver.getRooMcpPath(),
      format: "mcpServers",
    },
  },
  {
    key: "continue",
    name: "Continue",
    relativePath: ".continue/rules/00-obagents.md",
    owned: true,
    mcp: {
      configPath: () => pathResolver.getContinueMcpPath(),
      format: "array",
    },
  },
  {
    key: "copilot",
    name: "GitHub Copilot",
    relativePath: ".github/copilot-instructions.md",
    mcp: {
      configPath: () => pathResolver.getCopilotMcpPath(),
      format: "servers",
    },
  },
  {
    key: "claude-code",
    name: "Claude Code",
    relativePath: "CLAUDE.md",
    mcp: {
      configPath: () => pathResolver.getClaudeCodeMcpPath(),
      format: "mcpServers",
    },
    afterWrite: async (projectDir: string, agentName: string, options?: MapperWriteOptions) => {
      if (options?.dryRun) return;
      const filePath = join(projectDir, "CLAUDE.md");
      const settings = await readClaudeSettings();
      if (!settings.contextPaths.includes(filePath)) {
        settings.contextPaths.push(filePath);
        await writeClaudeSettings(settings);
      }
    },
    afterClean: async (projectDir: string, options?: MapperCleanOptions) => {
      const filePath = join(projectDir, "CLAUDE.md");
      const settings = await readClaudeSettings();
      const before = settings.contextPaths.length;
      settings.contextPaths = settings.contextPaths.filter((p) => p !== filePath);
      if (settings.contextPaths.length !== before && !options?.dryRun) {
        await writeClaudeSettings(settings);
      }
    },
  },
  {
    key: "generic",
    name: "Generic (AGENT.md)",
    relativePath: "AGENT.md",
    owned: true,
    passive: true,
  },
  {
    key: "opencode",
    name: "OpenCode CLI",
    relativePath: ".opencode/AGENTS.md",
    frontmatter: OPENCODE_FRONTMATTER,
    owned: true,
    mcp: {
      configPath: () => pathResolver.getOpenCodeMcpPath(),
      format: "opencode",
    },
  },
  {
    key: "codex",
    name: "Codex CLI",
    relativePath: ".codex/AGENTS.md",
    owned: true,
    checkDrift: async (projectDir: string) => {
      try {
        const args = await codexMcpArgs(["mcp", "get", "obagents"], projectDir);
        await runCodexMcp(args, projectDir);
        return { status: "in-sync" };
      } catch {
        return { status: "missing", diff: "Codex MCP server 'obagents' is not registered" };
      }
    },
    afterWrite: async (projectDir: string, agentName: string, options?: MapperWriteOptions) => {
      if (!options?.dryRun) {
        const bin = resolveBinaryCommand();
        try {
          const args = await codexMcpArgs(
            ["mcp", "add", "obagents", "--", bin, "serve"],
            projectDir,
          );
          await runCodexMcp(args, projectDir);
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : String(err);
          logger.error(`Codex MCP registration failed: ${msg}`);
          throw new Error(`Codex MCP registration failed: ${msg}`);
        }
      }
    },
    afterClean: async (_projectDir: string, _options?: MapperCleanOptions) => {
      // User-scope Codex gateway is preserved when unlinking an agent
    },
  },
  {
    key: "kilo",
    name: "Kilo",
    relativePath: ".kilo/AGENTS.md",
    owned: true,
    mcp: {
      configPath: (projectDir) => join(projectDir, "kilo.json"),
      format: "mcpServers",
    },
  },
  {
    key: "grok",
    name: "Grok Build",
    relativePath: ".grok/AGENTS.md",
    owned: true,
    mcp: {
      configPath: (projectDir) => join(projectDir, ".grok", "mcp.json"),
      format: "mcpServers",
    },
  },
  {
    key: "qwen",
    name: "Qwen Code",
    relativePath: ".qwen/AGENTS.md",
    owned: true,
    mcp: {
      configPath: (projectDir) => join(projectDir, ".qwen", "settings.json"),
      format: "mcpServers",
    },
  },
  {
    key: "pi",
    name: "Pi Agent",
    relativePath: ".pi/AGENTS.md",
    owned: true,
    mcp: {
      configPath: (projectDir) => join(projectDir, ".pi", "mcp.json"),
      format: "mcpServers",
    },
  },
  {
    key: "swe-agent",
    name: "SWE-Agent",
    relativePath: "swe_agent_instructions.md",
    passive: true,
  },
  {
    key: "antigravity",
    name: "Antigravity CLI",
    relativePath: "AGENTS.md",
    owned: false,
    mcp: {
      configPath: () => pathResolver.getAntigravityMcpPath(),
      format: "mcpServers",
    },
  },
  {
    key: "command-code",
    name: "Command Code",
    relativePath: "AGENTS.md",
    owned: false,
    mcp: {
      configPath: (projectDir) => join(projectDir, ".mcp.json"),
      format: "mcpServers",
    },
  },
  aiderDescriptor,
];
