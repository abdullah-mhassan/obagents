import { join, resolve } from "node:path";
import { fs } from "../utils/fs.js";
import { DESCRIPTORS } from "./mappers/declarations.js";
import { extractBlockContent } from "./markers.js";
import { vaultSyncEngine } from "../vault/sync.js";
import { parseJsonc, type McpFormat } from "./mcp.js";
import { targetAdapterEngine, getAgentMcpConfig } from "./engine.js";

export type DriftStatus = "in-sync" | "drifted" | "missing";

export interface TargetDrift {
  key: string;
  name: string;
  filePath: string;
  status: DriftStatus;
  diff?: string;
}

export interface ProjectDrift {
  projectDir: string;
  targets: TargetDrift[];
}

import { adapters } from "./adapters/mcp.js";

function checkMcpRegistration(
  config: Record<string, unknown>,
  format: McpFormat,
  serverName: string,
  expectedCommand: string,
  expectedArgs: string[],
): { status: DriftStatus; diff?: string } {
  const adapter = adapters[format];
  if (!adapter) {
    return { status: "in-sync" };
  }
  return adapter.checkRegistration(config, serverName, expectedCommand, expectedArgs);
}

export async function diffProject(projectDir?: string): Promise<ProjectDrift> {
  const dir = resolve(projectDir ?? process.cwd());
  const rosterAgents = await vaultSyncEngine.getAgentsForProject(dir);
  const activeAgent = (await vaultSyncEngine.getActiveAgentForProject(dir)) ?? rosterAgents[0];

  if (!activeAgent) {
    return { projectDir: dir, targets: [] };
  }

  const registeredTargetKeys = await vaultSyncEngine.getTargetsForAgent(activeAgent, dir);
  const rosterContext = { rosterAgents, activeAgent };
  const expectedMcp = getAgentMcpConfig(activeAgent, dir);


  const targets: TargetDrift[] = [];

  for (const key of registeredTargetKeys) {
    const descriptor = DESCRIPTORS.find((d) => d.key === key);
    const mapperName = descriptor?.name ?? key;
    const adapter = targetAdapterEngine.getAdapter(key);

    let artifactStatus: DriftStatus = "in-sync";
    let artifactDiff: string | undefined = undefined;
    const filePath = adapter?.filePath
      ? adapter.filePath(dir)
      : descriptor && "relativePath" in descriptor
        ? join(dir, descriptor.relativePath)
        : join(dir, key);

    // 1. Check the target's own artifact (markdown block, or adapter-level check for custom mappers)
    if (descriptor && "custom" in descriptor && descriptor.custom) {
      if (adapter?.checkDrift) {
        const result = await adapter.checkDrift(dir, activeAgent);
        artifactStatus = result.status;
        artifactDiff = result.diff;
      }
    } else if (filePath) {
      if (!fs.existsSync(filePath)) {
        artifactStatus = "missing";
      } else {
        const contents = await fs.readFile(filePath, "utf8");
        const actual = extractBlockContent(contents, activeAgent);
        const { content: expectedBlock } = await targetAdapterEngine.getExpectedContent(
          activeAgent,
          dir,
          key,
          rosterContext,
        );

        if (actual === null) {
          artifactStatus = "missing";
        } else if (actual !== expectedBlock) {
          artifactStatus = "drifted";
          artifactDiff = unifiedDiff(actual, expectedBlock);
        }
      }
    }

    // 2. Check MCP server registration if target uses MCP
    let mcpStatus: DriftStatus = "in-sync";
    let mcpDiff: string | undefined = undefined;

    if (descriptor && "mcp" in descriptor && descriptor.mcp) {
      const configPath =
        typeof descriptor.mcp.configPath === "function"
          ? descriptor.mcp.configPath(dir)
          : descriptor.mcp.configPath;

      if (!fs.existsSync(configPath)) {
        mcpStatus = "missing";
        mcpDiff = `MCP server "${expectedMcp.name}" configuration file missing at ${configPath}`;
      } else {
        const raw = await fs.readFile(configPath, "utf8");
        let parsedConfig: Record<string, unknown>;
        try {
          parsedConfig = parseJsonc(raw);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to parse MCP configuration file at ${configPath}: ${errMsg}`);
        }

        const checkResult = checkMcpRegistration(
          parsedConfig,
          descriptor.mcp.format,
          expectedMcp.name!,
          expectedMcp.command,
          expectedMcp.args,
        );
        mcpStatus = checkResult.status;
        if (checkResult.diff) {
          mcpDiff = checkResult.diff;
        }
      }
    } else if (adapter?.checkDrift && !(descriptor && "custom" in descriptor && descriptor.custom)) {
      const checkResult = await adapter.checkDrift(dir, activeAgent);
      mcpStatus = checkResult.status;
      if (checkResult.diff) {
        mcpDiff = checkResult.diff;
      }
    }

    // Combine artifact and MCP statuses
    let finalStatus: DriftStatus = "in-sync";
    let finalDiff: string | undefined = undefined;

    if (artifactStatus === "missing") {
      finalStatus = "missing";
    } else if (artifactStatus === "drifted" || mcpStatus === "drifted" || mcpStatus === "missing") {
      finalStatus = "drifted";
      finalDiff = artifactDiff || mcpDiff || "MCP configuration mismatch";
    }

    targets.push({
      key,
      name: mapperName,
      filePath,
      status: finalStatus,
      diff: finalDiff,
    });
  }

  return { projectDir: dir, targets };
}

export interface FixResult {
  projectDir: string;
  fixed: string[];
}

export async function fixDrift(projectDir?: string): Promise<FixResult> {
  const dir = resolve(projectDir ?? process.cwd());
  const { targets } = await diffProject(dir);
  const activeAgent = (await vaultSyncEngine.getActiveAgentForProject(dir)) ?? (await vaultSyncEngine.getAgentsForProject(dir))[0] ?? "hive";

  const fixed: string[] = [];
  for (const target of targets) {
    if (target.status === "in-sync") continue;
    await vaultSyncEngine.linkAgent(activeAgent, {
      targets: [target.key],
      force: true,
      projectDir: dir,
    });
    fixed.push(target.key);
  }

  return { projectDir: dir, fixed };
}

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
