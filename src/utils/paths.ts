import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTS_DIR_NAME,
  AGENTS_REGISTRY_FILE,
  AGENT_META_FILE,
  TRIAD_FILES,
  VAULT_DIR_NAME,
} from "./constants.js";

export class PathResolver {
  private homeDirOverride: string | null = null;
  private targetPathOverrides: Map<string, string> = new Map();

  public setHomeDir(dir: string | null): void {
    this.homeDirOverride = dir;
  }

  public getHomeDir(): string {
    return this.homeDirOverride ?? homedir();
  }

  public setTargetPath(target: string, path: string | null): void {
    if (path === null) {
      this.targetPathOverrides.delete(target);
    } else {
      this.targetPathOverrides.set(target, path);
    }
  }

  public getWindsurfMcpPath(): string {
    return (
      this.targetPathOverrides.get("windsurf") ??
      join(this.getHomeDir(), ".codeium", "windsurf", "mcp_config.json")
    );
  }

  public getRooMcpPath(): string {
    if (this.targetPathOverrides.has("roo")) {
      return this.targetPathOverrides.get("roo")!;
    }
    const platform = process.platform;
    if (platform === "darwin") {
      return join(
        this.getHomeDir(),
        "Library",
        "Application Support",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
        "cline_mcp_settings.json",
      );
    } else if (platform === "win32") {
      const base = this.homeDirOverride
        ? join(this.homeDirOverride, "AppData", "Roaming")
        : process.env.APPDATA || join(homedir(), "AppData", "Roaming");
      return join(
        base,
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
        "cline_mcp_settings.json",
      );
    } else {
      return join(
        this.getHomeDir(),
        ".config",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
        "cline_mcp_settings.json",
      );
    }
  }

  public getContinueMcpPath(): string {
    return (
      this.targetPathOverrides.get("continue") ??
      join(this.getHomeDir(), ".continue", "config.json")
    );
  }

  public getClaudeSettingsPath(): string {
    return (
      this.targetPathOverrides.get("claude") ??
      this.targetPathOverrides.get("claude-settings") ??
      join(this.getHomeDir(), ".claude", "settings.json")
    );
  }

  public getAntigravityMcpPath(): string {
    return (
      this.targetPathOverrides.get("antigravity") ??
      join(this.getHomeDir(), ".gemini", "config", "mcp_config.json")
    );
  }

  public getCursorMcpPath(): string {
    return (
      this.targetPathOverrides.get("cursor") ??
      join(this.getHomeDir(), ".cursor", "mcp.json")
    );
  }

  public getClaudeCodeMcpPath(): string {
    return (
      this.targetPathOverrides.get("claude-code") ??
      join(this.getHomeDir(), ".claude.json")
    );
  }

  public getCopilotMcpPath(): string {
    return (
      this.targetPathOverrides.get("copilot") ??
      join(this.getHomeDir(), ".vscode", "mcp.json")
    );
  }

  public getOpenCodeMcpPath(): string {
    return (
      this.targetPathOverrides.get("opencode") ??
      join(this.getHomeDir(), ".config", "opencode", "opencode.json")
    );
  }

  public reset(): void {
    this.homeDirOverride = null;
    this.targetPathOverrides.clear();
  }
}

export const pathResolver = new PathResolver();

let vaultRootOverride: string | null = null;

const __dirname = dirname(fileURLToPath(import.meta.url));

function findTemplatesDir(): string {
  // The templates directory ships at the package root. Unbundled source
  // (src/utils/) resolves it two levels up; the bundled CLI (dist/cli.js)
  // resolves it one level up. Probe both and prefer whichever exists.
  const candidates = [resolve(__dirname, "../../templates"), resolve(__dirname, "../templates")];
  return candidates.find((dir) => existsSync(join(dir, "archetypes"))) ?? candidates[0]!;
}

export const TEMPLATES_DIR = findTemplatesDir();

export function overrideVaultRoot(path: string | null): void {
  vaultRootOverride = path;
}

export function getVaultRoot(): string {
  return vaultRootOverride ?? process.env.OBAGENTS_VAULT_DIR ?? join(pathResolver.getHomeDir(), VAULT_DIR_NAME);
}

export function getRegistryPath(): string {
  return join(getVaultRoot(), AGENTS_REGISTRY_FILE);
}

export function getAgentsDir(): string {
  return join(getVaultRoot(), AGENTS_DIR_NAME);
}

export function getAgentDir(name: string): string {
  return join(getAgentsDir(), name);
}

export function getAgentMetaPath(name: string): string {
  return join(getAgentDir(name), AGENT_META_FILE);
}

export function getCoreFiles(): readonly string[] {
  return TRIAD_FILES;
}

export function overrideClaudeSettingsPath(path: string | null): void {
  pathResolver.setTargetPath("claude", path);
}

export function getClaudeSettingsPath(): string {
  return pathResolver.getClaudeSettingsPath();
}