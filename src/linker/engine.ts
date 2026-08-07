import { join, resolve } from "node:path";
import type { AdapterResult, McpServerConfig, LinkContext, TargetAdapter } from "./types.js";
import { createMapper } from "./mappers/base.js";
import { DESCRIPTORS } from "./mappers/declarations.js";
import { compileAgentContext, compileRosterContext } from "../vault/compiler.js";
import type { SupportedTarget } from "../utils/constants.js";
import { OBAGENTS_END_MARKER, OBAGENTS_START_PREFIX } from "../utils/constants.js";
import { fs } from "../utils/fs.js";

import { resolveBinaryCommand } from "./mcp.js";

export type DriftStatus = "in-sync" | "drifted" | "missing";

export function unifiedDiff(actual: string, expected: string): string {
  const a = actual.split("\n");
  const b = expected.split("\n");
  const lcs = longestCommonSubsequence(a, b);

  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj] of lcs) {
    while (i < ai) out.push(`- ${a[i++]}`);
    while (j < bj) out.push(`+ ${b[j++]}`);
    out.push(`  ${a[i]}`);
    i++;
    j++;
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);

  return out.join("\n");
}

function longestCommonSubsequence(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export function getAgentMcpConfig(_agentName?: string, _projectDir?: string): McpServerConfig {
  return {
    name: "obagents",
    command: resolveBinaryCommand(),
    args: ["serve"],
  };
}

export interface TargetApplyOptions {
  rosterAgents?: string[];
  activeAgent?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface TargetRemoveOptions {
  dryRun?: boolean;
  otherAgentHasTarget?: boolean;
  forceCleanMcp?: boolean;
}

export interface TargetApplyResult {
  target: string;
  key: string;
  result: AdapterResult;
}

export interface TargetRemoveResult {
  target: string;
  key: string;
  cleaned: boolean;
}

function getDefaultAdapters(): TargetAdapter[] {
  return DESCRIPTORS.map(createMapper);
}

const START_REGEX = /<!--\s*obagents:start[^>]*?-->\n?/i;
const END_REGEX = /<!--\s*obagents:end\s*-->\n?/i;
const BLOCK_REGEX = /<!--\s*obagents:start[^>]*?-->[\s\S]*?<!--\s*obagents:end\s*-->\n?/i;

function blockRegexFor(agentName?: string): RegExp {
  if (!agentName) return BLOCK_REGEX;
  const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `<!--\\s*obagents:start[^>]*?agent="${escaped}"[^>]*?-->[\\s\\S]*?<!--\\s*obagents:end\\s*-->\\n?`,
    "i",
  );
}

function blockStartTag(block: string): string {
  return /<!--\s*obagents:start[^>]*?-->/.exec(block)?.[0] ?? "";
}

function firstLegacyBlock(content: string): { index: number; length: number } | null {
  const regex = new RegExp(BLOCK_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const agentAttr = /agent="([^"]*)"/i.exec(blockStartTag(match[0]));
    if (!agentAttr || agentAttr[1] === "hive") {
      return { index: match.index, length: match[0].length };
    }
  }
  return null;
}

export class TargetAdapterEngine {
  private registry = new Map<SupportedTarget, TargetAdapter>();

  constructor(adapters: TargetAdapter[] = getDefaultAdapters()) {
    for (const adapter of adapters) {
      this.registry.set(adapter.key as SupportedTarget, adapter);
    }
  }

  static buildStartMarker(agentName: string, generatedIso = new Date().toISOString()): string {
    return `<!-- obagents:start agent="${agentName}" generated="${generatedIso}" -->`;
  }

  static buildEndMarker(): string {
    return OBAGENTS_END_MARKER;
  }

  static buildBlock(content: string, agentName: string, generatedIso?: string): string {
    return `${TargetAdapterEngine.buildStartMarker(agentName, generatedIso)}\n${content.trim()}\n${TargetAdapterEngine.buildEndMarker()}`;
  }

  static hasBlock(fileContent: string, agentName?: string): boolean {
    return blockRegexFor(agentName).test(fileContent);
  }

  static hasLegacyBlock(fileContent: string): boolean {
    return firstLegacyBlock(fileContent) !== null;
  }

  static hasAgentScopedBlock(fileContent: string): boolean {
    const regex = new RegExp(BLOCK_REGEX.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(fileContent)) !== null) {
      const agentAttr = /agent="([^"]*)"/i.exec(blockStartTag(match[0]));
      if (agentAttr && agentAttr[1] !== "hive") {
        return true;
      }
    }
    return false;
  }

  static removeLegacyBlock(existingContent: string): string {
    const found = firstLegacyBlock(existingContent);
    if (!found) {
      return existingContent;
    }
    const remaining =
      existingContent.slice(0, found.index) + existingContent.slice(found.index + found.length);
    return remaining.replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "").replace(/\s+$/, "") + "\n";
  }

  static injectBlock(existingContent: string, block: string, agentName?: string): string {
    const trimmed = existingContent.replace(/\s+$/, "");
    if (TargetAdapterEngine.hasBlock(existingContent, agentName)) {
      const regex = blockRegexFor(agentName);
      return existingContent.replace(regex, () => block + "\n");
    }
    const legacy = firstLegacyBlock(existingContent);
    if (legacy) {
      return (
        existingContent.slice(0, legacy.index) +
        block +
        "\n" +
        existingContent.slice(legacy.index + legacy.length)
      );
    }
    if (trimmed.length === 0) {
      return block + "\n";
    }
    return `${trimmed}\n\n${block}\n`;
  }

  static removeBlock(existingContent: string, agentName?: string): string {
    const regex = new RegExp(blockRegexFor(agentName).source, "gi");
    const remaining = existingContent.replace(regex, "").replace(/\n{3,}/g, "\n\n");
    return remaining.replace(/^\s+/, "").replace(/\s+$/, "") + (remaining.endsWith("\n") ? "" : "\n");
  }

  static extractBlockContent(fileContent: string, agentName?: string): string | null {
    const match = blockRegexFor(agentName).exec(fileContent);
    if (!match) return null;
    const block = match[0];
    const inner = block.replace(START_REGEX, "").replace(END_REGEX, "");
    return inner.trim();
  }

  static isStartMarker(line: string): boolean {
    return line.trim().startsWith(OBAGENTS_START_PREFIX);
  }

  static isEndMarker(line: string): boolean {
    return END_REGEX.test(line);
  }

  buildStartMarker(agentName: string, generatedIso?: string): string {
    return TargetAdapterEngine.buildStartMarker(agentName, generatedIso);
  }

  buildEndMarker(): string {
    return TargetAdapterEngine.buildEndMarker();
  }

  buildBlock(content: string, agentName: string, generatedIso?: string): string {
    return TargetAdapterEngine.buildBlock(content, agentName, generatedIso);
  }

  hasBlock(fileContent: string, agentName?: string): boolean {
    return TargetAdapterEngine.hasBlock(fileContent, agentName);
  }

  hasLegacyBlock(fileContent: string): boolean {
    return TargetAdapterEngine.hasLegacyBlock(fileContent);
  }

  hasAgentScopedBlock(fileContent: string): boolean {
    return TargetAdapterEngine.hasAgentScopedBlock(fileContent);
  }

  removeLegacyBlock(existingContent: string): string {
    return TargetAdapterEngine.removeLegacyBlock(existingContent);
  }

  injectBlock(existingContent: string, block: string, agentName?: string): string {
    return TargetAdapterEngine.injectBlock(existingContent, block, agentName);
  }

  removeBlock(existingContent: string, agentName?: string): string {
    return TargetAdapterEngine.removeBlock(existingContent, agentName);
  }

  extractBlockContent(fileContent: string, agentName?: string): string | null {
    return TargetAdapterEngine.extractBlockContent(fileContent, agentName);
  }

  isStartMarker(line: string): boolean {
    return TargetAdapterEngine.isStartMarker(line);
  }

  isEndMarker(line: string): boolean {
    return TargetAdapterEngine.isEndMarker(line);
  }

  getAdapter(key: string): TargetAdapter | undefined {
    return this.registry.get(key as SupportedTarget);
  }

  getAdapters(): TargetAdapter[] {
    return Array.from(this.registry.values());
  }

  private createContext(
    agentName: string,
    projectDir: string,
    targets: string[],
    rosterAgents: string[] = [],
    activeAgent?: string,
  ): LinkContext {
    return {
      agentName,
      projectDir,
      targets,
      async getRosterContent() {
        return compileRosterContext(projectDir, rosterAgents, activeAgent, { extraAgents: [agentName] });
      },
      async getPassiveContent() {
        const roster = await compileRosterContext(projectDir, rosterAgents, activeAgent, { extraAgents: [agentName] });
        const compiled = await compileAgentContext(agentName, projectDir);
        return `${roster}\n\n${compiled.content}`;
      },
      async getAgentMcpConfig(): Promise<McpServerConfig> {
        return getAgentMcpConfig(agentName, projectDir);
      },
    };
  }

  async applyTarget(
    agentName: string,
    projectDir: string,
    targetKey: string,
    options?: TargetApplyOptions,
  ): Promise<TargetApplyResult> {
    const results = await this.applyTargets(agentName, projectDir, [targetKey], options);
    const res = results[0];
    if (!res) {
      throw new Error(`Target "${targetKey}" application returned no result.`);
    }
    return res;
  }

  async applyTargets(
    agentName: string,
    projectDir: string,
    targets: string[],
    options?: TargetApplyOptions,
  ): Promise<TargetApplyResult[]> {
    const resolvedDir = resolve(projectDir);
    const context = this.createContext(
      agentName,
      resolvedDir,
      targets,
      options?.rosterAgents,
      options?.activeAgent,
    );
    const results: TargetApplyResult[] = [];

    for (const key of targets) {
      const adapter = this.registry.get(key as SupportedTarget);
      if (!adapter) {
        throw new Error(`No mapper registered for target "${key}".`);
      }
      const result = await adapter.apply(context, {
        dryRun: options?.dryRun,
        force: options?.force,
      });
      results.push({ target: key, key, result });
    }

    return results;
  }

  async removeTarget(
    agentName: string,
    projectDir: string,
    targetKey: string,
    options?: TargetRemoveOptions,
  ): Promise<TargetRemoveResult> {
    const results = await this.removeTargets(agentName, projectDir, [targetKey], options);
    const res = results[0];
    if (!res) {
      throw new Error(`Target "${targetKey}" removal returned no result.`);
    }
    return res;
  }

  async removeTargets(
    agentName: string,
    projectDir: string,
    targets: string[],
    options?: TargetRemoveOptions,
  ): Promise<TargetRemoveResult[]> {
    const resolvedDir = resolve(projectDir);
    const context = this.createContext(agentName, resolvedDir, targets);
    const results: TargetRemoveResult[] = [];

    for (const key of targets) {
      const adapter = this.registry.get(key as SupportedTarget);
      if (!adapter) {
        throw new Error(`No mapper registered for target "${key}".`);
      }

      const removeResult = await adapter.remove(context, {
        dryRun: options?.dryRun,
        agentName,
        otherAgentHasTarget: options?.otherAgentHasTarget,
        forceCleanMcp: options?.forceCleanMcp,
      });

      results.push({ target: key, key, cleaned: removeResult.cleaned });
    }

    return results;
  }

  async getExpectedContent(
    agentName: string,
    projectDir: string,
    targetKey: string,
    rosterContext?: { rosterAgents?: string[]; activeAgent?: string },
  ): Promise<{ content: string; mcpConfig?: McpServerConfig }> {
    const resolvedDir = resolve(projectDir);
    const context = this.createContext(
      agentName,
      resolvedDir,
      [targetKey],
      rosterContext?.rosterAgents,
      rosterContext?.activeAgent,
    );
    const adapter = this.registry.get(targetKey as SupportedTarget);
    if (!adapter) {
      throw new Error(`No mapper registered for target "${targetKey}".`);
    }

    const descriptor = DESCRIPTORS.find((d) => d.key === targetKey);
    const isPassive = Boolean(descriptor && "passive" in descriptor && descriptor.passive);
    const content = isPassive ? await context.getPassiveContent() : await context.getRosterContent();
    const mcpConfig =
      descriptor && "mcp" in descriptor && descriptor.mcp
        ? await context.getAgentMcpConfig()
        : undefined;

    return { content: content.trim(), mcpConfig };
  }

  async diffTarget(
    agentName: string,
    projectDir: string,
    targetKey: string,
    rosterContext?: { rosterAgents?: string[]; activeAgent?: string },
  ): Promise<{ status: DriftStatus; diff?: string }> {
    const resolvedDir = resolve(projectDir);
    const adapter = this.registry.get(targetKey as SupportedTarget);
    const descriptor = DESCRIPTORS.find((d) => d.key === targetKey);

    if (descriptor && "custom" in descriptor && descriptor.custom) {
      if (adapter?.checkDrift) {
        return adapter.checkDrift(resolvedDir, agentName);
      }
      return { status: "in-sync" };
    }

    const filePath = adapter?.filePath
      ? adapter.filePath(resolvedDir)
      : descriptor && "relativePath" in descriptor
        ? join(resolvedDir, descriptor.relativePath)
        : join(resolvedDir, targetKey);

    if (!filePath || !fs.existsSync(filePath)) {
      return { status: "missing" };
    }

    const contents = await fs.readFile(filePath, "utf8");
    const actual = TargetAdapterEngine.extractBlockContent(contents, agentName);
    const { content: expectedBlock } = await this.getExpectedContent(
      agentName,
      resolvedDir,
      targetKey,
      rosterContext,
    );

    if (actual === null) {
      return { status: "missing" };
    }
    if (actual !== expectedBlock) {
      return {
        status: "drifted",
        diff: unifiedDiff(actual, expectedBlock),
      };
    }

    return { status: "in-sync" };
  }
}

export const targetAdapterEngine = new TargetAdapterEngine();

