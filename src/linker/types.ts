import type { SupportedTarget } from "../utils/constants.js";

export interface AdapterResult {
  filePath: string;
  action: "created" | "updated" | "modified";
}
export type MapperResult = AdapterResult;

export interface MapperWriteOptions {
  force?: boolean;
  dryRun?: boolean;
}

export interface MapperCleanOptions {
  dryRun?: boolean;
  agentName?: string;
  otherAgentHasTarget?: boolean;
  forceCleanMcp?: boolean;
}

export interface McpServerConfig {
  name?: string;
  command: string;
  args: string[];
}

export interface LinkContext {
  readonly agentName: string;
  readonly projectDir: string;
  readonly targets: readonly string[];
  getRosterContent(): Promise<string>;
  getPassiveContent(): Promise<string>;
  getAgentMcpConfig(): Promise<McpServerConfig>;
}

export interface DriftCheckResult {
  status: "in-sync" | "drifted" | "missing";
  diff?: string;
}

export interface TargetAdapter {
  readonly name: string;
  readonly key: SupportedTarget;
  apply(context: LinkContext, options?: { dryRun?: boolean; force?: boolean }): Promise<AdapterResult>;
  remove(
    context: LinkContext,
    options?: { dryRun?: boolean; agentName?: string; otherAgentHasTarget?: boolean; forceCleanMcp?: boolean },
  ): Promise<{ cleaned: boolean }>;
  detect(projectDir: string): boolean | Promise<boolean>;
  filePath?(projectDir: string): string;
  checkDrift?(projectDir: string, agentName: string): DriftCheckResult | Promise<DriftCheckResult>;
}

export interface CompiledAgent {
  content: string;
  needsConsolidation: boolean;
}