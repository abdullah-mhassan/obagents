import { dirname, join } from "node:path";
import type { SupportedTarget } from "../../utils/constants.js";
import type { MapperResult, MapperWriteOptions, MapperCleanOptions, TargetAdapter, LinkContext } from "../types.js";
import { TargetAdapterEngine } from "../engine.js";
import { fs } from "../../utils/fs.js";
import type { McpFormat } from "../mcp.js";
import { manageMcpConfig } from "../mcp.js";

export interface MarkdownMapperOptions {
  key: SupportedTarget;
  name: string;
  relativePath: string;
  frontmatter?: string;
  owned?: boolean;
  passive?: boolean;
}

export function createMarkdownMapper(options: MarkdownMapperOptions): TargetAdapter {
  const { key, name, relativePath, frontmatter, owned = false } = options;
  const prefix = frontmatter ?? "";

  function resolvePath(projectDir: string): string {
    return join(projectDir, relativePath);
  }

  return {
    name,
    key,
    async apply(
      context: LinkContext,
      writeOptions: MapperWriteOptions = {},
    ): Promise<MapperResult> {
      const filePath = resolvePath(context.projectDir);
      const compiledContent = options.passive && context.getPassiveContent
        ? await context.getPassiveContent()
        : await context.getRosterContent();
      const block = TargetAdapterEngine.buildBlock(compiledContent, context.agentName);

      const fileExists = fs.existsSync(filePath);
      let action: MapperResult["action"] = "created";

      if (writeOptions.dryRun) {
        if (fileExists) {
          const existing = await fs.readFile(filePath, "utf8");
          action = blockNeedsReplacement(existing, context.agentName) ? "updated" : "modified";
        }
        return { filePath, action };
      }

      await fs.mkdir(dirname(filePath), { recursive: true });

      if (!fileExists) {
        const head = prefix ? `${prefix}\n\n` : "";
        await fs.writeFile(filePath, `${head}${block}\n`, "utf8");
        return { filePath, action: "created" };
      }

      const existing = await fs.readFile(filePath, "utf8");
      action = blockNeedsReplacement(existing, context.agentName) ? "updated" : "modified";

      const updated = modifyPreservingPrefix(existing, prefix, (body) =>
        TargetAdapterEngine.injectBlock(body, block, context.agentName),
      );

      await fs.writeFile(filePath, ensureTrailingNewline(updated), "utf8");
      return { filePath, action };
    },

    async remove(context: LinkContext, options: MapperCleanOptions = {}): Promise<{ cleaned: boolean }> {
      const agentName = options.agentName ?? context.agentName;
      const filePath = resolvePath(context.projectDir);
      if (!fs.existsSync(filePath)) {
        return { cleaned: false };
      }
      const existing = await fs.readFile(filePath, "utf8");
      const removeLegacy = TargetAdapterEngine.hasLegacyBlock(existing) && !TargetAdapterEngine.hasAgentScopedBlock(existing);
      if (!TargetAdapterEngine.hasBlock(existing, agentName) && !removeLegacy) {
        return { cleaned: false };
      }
      if (options.dryRun) {
        return { cleaned: true };
      }
      if (owned && !hasOtherBlockOrUserContent(existing, agentName)) {
        await fs.rm(filePath, { force: true });
        return { cleaned: true };
      }
      let isEmpty = false;
      const final = modifyPreservingPrefix(existing, prefix, (body) => {
        let remaining = TargetAdapterEngine.removeBlock(body, agentName);
        if (removeLegacy) {
          remaining = TargetAdapterEngine.removeLegacyBlock(remaining);
        }
        isEmpty = remaining.trim().length === 0;
        return remaining;
      });
      if (isEmpty) {
        await fs.rm(filePath, { force: true });
      } else {
        await fs.mkdir(dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, final, "utf8");
      }
      return { cleaned: true };
    },

    detect(projectDir: string): boolean {
      return fs.existsSync(resolvePath(projectDir));
    },

    filePath(projectDir: string): string {
      return resolvePath(projectDir);
    },
  };
}

function stripPrefix(content: string, prefix: string): string | null {
  if (!prefix) return null;
  const trimmed = content.replace(/^\s+/, "");
  if (trimmed.startsWith(prefix.replace(/\s+$/, ""))) {
    const after = trimmed.slice(prefix.replace(/\s+$/, "").length);
    return after.replace(/^\s+/, "");
  }
  return null;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function blockNeedsReplacement(existing: string, agentName: string): boolean {
  return TargetAdapterEngine.hasBlock(existing, agentName) || TargetAdapterEngine.hasLegacyBlock(existing);
}

function hasOtherBlockOrUserContent(existing: string, agentName: string): boolean {
  const afterTarget = TargetAdapterEngine.removeBlock(existing, agentName);
  return afterTarget.trim().length > 0;
}

function modifyPreservingPrefix(existing: string, prefix: string | undefined, modifier: (body: string) => string): string {
  const p = prefix ?? "";
  const body = p ? (stripPrefix(existing, p) ?? existing) : existing;
  const updatedBody = modifier(body);
  return p ? `${p}\n\n${updatedBody}` : updatedBody;
}

export interface MarkdownMcpDescriptor {
  key: SupportedTarget;
  name: string;
  relativePath: string;
  frontmatter?: string;
  owned?: boolean;
  passive?: boolean;
  mcp?: {
    configPath: string | ((projectDir: string) => string);
    format: McpFormat;
  };
  checkDrift?: (
    projectDir: string,
    agentName: string,
  ) => import("../types.js").DriftCheckResult | Promise<import("../types.js").DriftCheckResult>;
  afterWrite?: (projectDir: string, agentName: string, options?: MapperWriteOptions) => Promise<void>;
  afterClean?: (projectDir: string, options?: MapperCleanOptions) => Promise<void>;
}

export interface CustomMapperDescriptor {
  key: SupportedTarget;
  name: string;
  custom: true;
  apply(context: import("../types.js").LinkContext, options?: MapperWriteOptions): Promise<MapperResult>;
  remove(context: import("../types.js").LinkContext, options?: MapperCleanOptions): Promise<{ cleaned: boolean }>;
  detect(projectDir: string): boolean | Promise<boolean>;
  filePath?(projectDir: string): string;
  checkDrift?(
    projectDir: string,
    agentName: string,
  ): import("../types.js").DriftCheckResult | Promise<import("../types.js").DriftCheckResult>;
}

export type MapperDescriptor = MarkdownMcpDescriptor | CustomMapperDescriptor;

function resolveMcpConfigPath(mcp: { configPath: string | ((projectDir: string) => string) }, projectDir: string): string {
  return typeof mcp.configPath === "function" ? mcp.configPath(projectDir) : mcp.configPath;
}

import { isGlobalCapableTarget } from "../../utils/constants.js";

export function createMarkdownMcpMapper(descriptor: MarkdownMcpDescriptor): TargetAdapter {
  const baseMapper = createMarkdownMapper({
    key: descriptor.key,
    name: descriptor.name,
    relativePath: descriptor.relativePath,
    frontmatter: descriptor.frontmatter,
    owned: descriptor.owned,
    passive: descriptor.passive,
  });

  return {
    ...baseMapper,
    ...(descriptor.checkDrift ? { checkDrift: descriptor.checkDrift } : {}),
    async apply(context: LinkContext, options?: MapperWriteOptions): Promise<MapperResult> {
      const result = await baseMapper.apply(context, options);

      if (descriptor.mcp) {
        const configPath = resolveMcpConfigPath(descriptor.mcp, context.projectDir);
        const mcpConfig = await context.getAgentMcpConfig();

        await manageMcpConfig({
          agentName: context.agentName,
          projectDir: context.projectDir,
          configPath,
          format: descriptor.mcp.format,
          action: "link",
          dryRun: options?.dryRun,
          command: mcpConfig.command,
          args: mcpConfig.args,
          serverName: mcpConfig.name,
        });
      }

      if (descriptor.afterWrite) {
        await descriptor.afterWrite(context.projectDir, context.agentName, options);
      }

      return result;
    },

    async remove(context: LinkContext, options?: MapperCleanOptions): Promise<{ cleaned: boolean }> {
      const result = await baseMapper.remove(context, options);

      if (descriptor.mcp && context.agentName) {
        const isGlobal = isGlobalCapableTarget(descriptor.key);
        if (!isGlobal) {
          const shouldRemoveMcp = options?.forceCleanMcp || !options?.otherAgentHasTarget;
          if (shouldRemoveMcp) {
            const configPath = resolveMcpConfigPath(descriptor.mcp, context.projectDir);
            await manageMcpConfig({
              agentName: context.agentName,
              projectDir: context.projectDir,
              configPath,
              format: descriptor.mcp.format,
              action: "unlink",
              dryRun: options?.dryRun,
              serverName: "obagents",
            });
          }
        }
      }

      if (descriptor.afterClean) {
        await descriptor.afterClean(context.projectDir, options);
      }
      return result;
    },
  };
}

export function createMapper(descriptor: MapperDescriptor): TargetAdapter {
  if ("custom" in descriptor && descriptor.custom) {
    return descriptor as TargetAdapter;
  }
  return createMarkdownMcpMapper(descriptor as MarkdownMcpDescriptor);
}