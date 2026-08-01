import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { TRIAD_FILES } from "../../utils/constants.js";
import type { MapperWriteOptions, MapperCleanOptions, MapperResult } from "../types.js";
import type { MapperDescriptor } from "./base.js";
import { fs } from "../../utils/fs.js";
import { getCoreFilePath, projectVault } from "../../vault/project.js";
import { logger } from "../../utils/logger.js";
import { getAgentsDir } from "../../utils/paths.js";

const AIDER_RELATIVE_PATH = ".aider.conf.yml";

function resolveAiderPath(projectDir: string): string {
  return join(projectDir, AIDER_RELATIVE_PATH);
}

function agentCorePaths(agentName: string, projectDir: string): string[] {
  return TRIAD_FILES.map((file) => getCoreFilePath(agentName, file, projectDir));
}

function collectAllVaultCorePaths(config: Record<string, unknown>): string[] {
  const read = Array.isArray(config.read) ? (config.read as string[]) : [];
  return read.filter((p) => p.includes(getAgentsDir()));
}

function parseAiderConfig(raw: string): Record<string, unknown> {
  const parsed = parseYaml(raw);
  return (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
}

export const aiderDescriptor: MapperDescriptor = {
  key: "aider",
  name: "Aider",
  custom: true,
  async apply(
    context: import("../types.js").LinkContext,
    writeOptions: MapperWriteOptions = {},
  ): Promise<MapperResult> {
    const projectDir = context.projectDir;
    const agentName = context.agentName;
    const filePath = resolveAiderPath(projectDir);
    const toAdd = agentCorePaths(agentName, projectDir);
    const fileExists = fs.existsSync(filePath);
    let action: MapperResult["action"] = fileExists ? "modified" : "created";

    if (writeOptions.dryRun) {
      return { filePath, action };
    }

    await projectVault.ensureProjectMemoryExists(agentName, projectDir);

    await fs.mkdir(dirname(filePath), { recursive: true });

    let config: Record<string, unknown> = {};
    if (fileExists) {
      const raw = await fs.readFile(filePath, "utf8");
      try {
        config = parseAiderConfig(raw);
      } catch {
        if (!writeOptions.force) {
          throw new Error(
            `Failed to parse existing "${AIDER_RELATIVE_PATH}". Use --force to reset it.`,
          );
        }
        config = {};
      }
    }

    const read = Array.isArray(config.read) ? [...(config.read as string[])] : [];
    for (const path of toAdd) {
      if (!read.includes(path)) {
        read.push(path);
      }
    }
    config.read = read;

    await fs.writeFile(filePath, stringifyYaml(config), "utf8");
    return { filePath, action };
  },

  async remove(context: import("../types.js").LinkContext, options: MapperCleanOptions = {}): Promise<{ cleaned: boolean }> {
    const projectDir = context.projectDir;
    const filePath = resolveAiderPath(projectDir);
    if (!fs.existsSync(filePath)) {
      return { cleaned: false };
    }
    const raw = await fs.readFile(filePath, "utf8");
    let config: Record<string, unknown>;
    try {
      config = parseAiderConfig(raw);
    } catch {
      logger.warning(`Could not parse "${AIDER_RELATIVE_PATH}"; leaving it untouched.`);
      return { cleaned: false };
    }

    if (options.dryRun) {
      return { cleaned: true };
    }

    const agentName = options.agentName ?? context.agentName;
    const allVaultPaths = agentName
      ? agentCorePaths(agentName, projectDir)
      : collectAllVaultCorePaths(config);

    const read = Array.isArray(config.read) ? (config.read as string[]) : [];
    const filtered = read.filter((p) => !allVaultPaths.includes(p));
    if (filtered.length === 0) {
      delete config.read;
    } else {
      config.read = filtered;
    }

    const remainingKeys = Object.keys(config).filter((k) => config[k] !== undefined);
    if (remainingKeys.length === 0) {
      await fs.rm(filePath, { force: true });
    } else {
      await fs.writeFile(filePath, stringifyYaml(config), "utf8");
    }
    return { cleaned: true };
  },

  detect(projectDir: string): boolean {
    return fs.existsSync(resolveAiderPath(projectDir));
  },

  filePath(projectDir: string): string {
    return resolveAiderPath(projectDir);
  },

  async checkDrift(projectDir: string, agentName: string): Promise<import("../types.js").DriftCheckResult> {
    const filePath = resolveAiderPath(projectDir);
    if (!fs.existsSync(filePath)) {
      return { status: "missing" };
    }
    let config: Record<string, unknown>;
    try {
      config = parseAiderConfig(await fs.readFile(filePath, "utf8"));
    } catch {
      return { status: "drifted", diff: `Could not parse ${AIDER_RELATIVE_PATH}` };
    }
    const read = Array.isArray(config.read) ? (config.read as string[]) : [];
    const missing = agentCorePaths(agentName, projectDir).filter((p) => !read.includes(p));
    if (missing.length === 0) {
      return { status: "in-sync" };
    }
    return { status: "drifted", diff: missing.map((p) => `+ ${p}`).join("\n") };
  },
};
