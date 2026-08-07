import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fs, writeJsonAtomic } from "../utils/fs.js";
import { getAgentDir } from "../utils/paths.js";
import { withLock, withCrossProcessLock } from "../utils/mutex.js";
import { CorruptStoreError } from "../utils/errors.js";

export interface ProjectConfig {
  activeAgent?: string;
  linkedAgents: string[];
}

export interface ProjectRef {
  path: string;
  hash: string;
  rootDir: string | null;
}

const PROJECT_CONFIG_FILE = ".obagents-project.json";

import { realpathSync } from "node:fs";

export class ProjectVault {
  normalizeProjectPath(projectDir: string): string {
    let resolved = resolve(projectDir);
    try {
      resolved = realpathSync(resolved);
    } catch {
      // Path may not exist yet or in virtual FS; resolve is sufficient fallback
    }
    resolved = resolved.replace(/\\/g, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  getProjectHash(projectDir: string): string {
    const normalized = this.normalizeProjectPath(projectDir);
    return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  }

  findProjectRoot(dir: string): string | null {
    let currentDir = resolve(dir);
    while (true) {
      const jsonPath = join(currentDir, PROJECT_CONFIG_FILE);
      if (fs.existsSync(jsonPath)) {
        return currentDir;
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
    return null;
  }

  resolve(projectDir: string): ProjectRef {
    const path = this.normalizeProjectPath(projectDir);
    const hash = this.getProjectHash(projectDir);
    const rootDir = this.findProjectRoot(projectDir);
    return { path, hash, rootDir };
  }

  private getProjectConfigPath(projectDir: string): string {
    const rootDir = this.findProjectRoot(projectDir);
    return join(rootDir ?? projectDir, PROJECT_CONFIG_FILE);
  }

  async getProjectConfig(projectDir: string): Promise<ProjectConfig> {
    const path = this.getProjectConfigPath(projectDir);
    if (!fs.existsSync(path)) {
      return { linkedAgents: [] };
    }
    const raw = await fs.readFile(path, "utf8");
    let parsed: Partial<ProjectConfig>;
    try {
      parsed = JSON.parse(raw) as Partial<ProjectConfig>;
    } catch {
      throw new CorruptStoreError("project config", path);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new CorruptStoreError("project config", path);
    }
    return {
      activeAgent: parsed.activeAgent,
      linkedAgents: parsed.linkedAgents ?? [],
    };
  }

  async writeProjectConfig(projectDir: string, config: ProjectConfig): Promise<void> {
    const path = this.getProjectConfigPath(projectDir);
    await writeJsonAtomic(path, config);
  }

  async updateProjectConfig(
    projectDir: string,
    patch: (config: ProjectConfig) => ProjectConfig | Promise<ProjectConfig>,
  ): Promise<ProjectConfig> {
    const path = this.getProjectConfigPath(projectDir);
    return withCrossProcessLock(`${path}.lock`, () =>
      withLock(path, async () => {
        const current = await this.getProjectConfig(projectDir);
        const next = await patch(current);
        await this.writeProjectConfig(projectDir, next);
        return next;
      }),
    );
  }

  getCoreFilePath(name: string, file: string, projectDir?: string): string {
    if (file === "MEMORY.md" && projectDir) {
      const hash = this.getProjectHash(projectDir);
      return join(getAgentDir(name), "projects", hash, file);
    }
    return join(getAgentDir(name), file);
  }

  async ensureProjectMemoryExists(agentName: string, projectDir: string): Promise<string> {
    const hash = this.getProjectHash(projectDir);
    const projectMemoryDir = join(getAgentDir(agentName), "projects", hash);
    const memoryFilePath = join(projectMemoryDir, "MEMORY.md");
    const projectJsonPath = join(projectMemoryDir, "project.json");

    if (!fs.existsSync(projectMemoryDir)) {
      await fs.mkdir(projectMemoryDir, { recursive: true });
    }

    if (!fs.existsSync(memoryFilePath)) {
      const { DEFAULT_MEMORY_TEMPLATE } = await import("./compiler.js");
      const populated = DEFAULT_MEMORY_TEMPLATE.replaceAll("{{AGENT_NAME}}", agentName);
      await fs.writeFile(memoryFilePath, populated, "utf8");
    }

    const absoluteNormalizedPath = this.normalizeProjectPath(projectDir);
    let linkedAt = new Date().toISOString();
    if (fs.existsSync(projectJsonPath)) {
      try {
        const existingContent = await fs.readFile(projectJsonPath, "utf8");
        const parsed = JSON.parse(existingContent);
        if (parsed && typeof parsed.linkedAt === "string") {
          linkedAt = parsed.linkedAt;
        }
      } catch {
        // ignore
      }
    }

    const projectJson = {
      path: absoluteNormalizedPath,
      linkedAt,
    };
    await fs.writeFile(projectJsonPath, JSON.stringify(projectJson, null, 2), "utf8");

    return memoryFilePath;
  }
}

export const projectVault = new ProjectVault();

// Backward-compatible function exports delegating to projectVault singleton
export function normalizeProjectPath(projectDir: string): string {
  return projectVault.normalizeProjectPath(projectDir);
}

export function getProjectHash(projectDir: string): string {
  return projectVault.getProjectHash(projectDir);
}

export function findProjectRoot(dir: string): string | null {
  return projectVault.findProjectRoot(dir);
}

export function getProjectConfig(projectDir: string): Promise<ProjectConfig> {
  return projectVault.getProjectConfig(projectDir);
}

export function writeProjectConfig(projectDir: string, config: ProjectConfig): Promise<void> {
  return projectVault.writeProjectConfig(projectDir, config);
}

export function getCoreFilePath(name: string, file: string, projectDir?: string): string {
  return projectVault.getCoreFilePath(name, file, projectDir);
}

export function ensureProjectMemoryExists(agentName: string, projectDir: string): Promise<string> {
  return projectVault.ensureProjectMemoryExists(agentName, projectDir);
}
