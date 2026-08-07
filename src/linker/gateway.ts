import { fs } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import {
  GLOBAL_CAPABLE_TARGETS,
  type SupportedTarget,
} from "../utils/constants.js";
import { DESCRIPTORS } from "./mappers/declarations.js";
import { manageMcpConfig, parseJsonc, resolveBinaryCommand } from "./mcp.js";
import { adapters } from "./adapters/mcp.js";
import { runCodexMcp } from "./mappers/declarations.js";
import { resolve } from "node:path";

export interface GatewayStatusItem {
  key: SupportedTarget;
  name: string;
  status: "registered" | "missing";
  global: boolean;
}

export async function installGateway(options?: { dryRun?: boolean }): Promise<{ installed: string[]; errors: string[] }> {
  const installed: string[] = [];
  const errors: string[] = [];
  const bin = resolveBinaryCommand();

  for (const descriptor of DESCRIPTORS) {
    if (!GLOBAL_CAPABLE_TARGETS.includes(descriptor.key as any)) {
      continue;
    }

    if (descriptor.key === "codex") {
      if (!options?.dryRun) {
        try {
          await runCodexMcp(["mcp", "add", "obagents", "--scope", "user", "--", bin, "serve"]);
          installed.push("codex");
        } catch (err) {
          const msg = `Codex MCP add failed: ${err instanceof Error ? err.message : String(err)}`;
          logger.warning(msg);
          errors.push(msg);
        }
      } else {
        installed.push("codex");
      }
      continue;
    }

    if ("mcp" in descriptor && descriptor.mcp) {
      const mcpSpec = descriptor.mcp;
      const configPath =
        typeof mcpSpec.configPath === "function"
          ? mcpSpec.configPath("")
          : mcpSpec.configPath;

      try {
        await manageMcpConfig({
          agentName: "gateway",
          projectDir: "",
          configPath,
          format: mcpSpec.format,
          action: "link",
          dryRun: options?.dryRun,
          command: bin,
          args: ["serve"],
          serverName: "obagents",
        });
        installed.push(descriptor.key);
      } catch (err) {
        const msg = `Failed to install gateway for ${descriptor.key}: ${err instanceof Error ? err.message : String(err)}`;
        logger.warning(msg);
        errors.push(msg);
      }
    }
  }

  return { installed, errors };
}

export async function uninstallGateway(options?: { dryRun?: boolean }): Promise<{ uninstalled: string[]; errors: string[] }> {
  const uninstalled: string[] = [];
  const errors: string[] = [];

  for (const descriptor of DESCRIPTORS) {
    if (!GLOBAL_CAPABLE_TARGETS.includes(descriptor.key as any)) {
      continue;
    }

    if (descriptor.key === "codex") {
      if (!options?.dryRun) {
        try {
          await runCodexMcp(["mcp", "remove", "obagents", "--scope", "user"]);
          uninstalled.push("codex");
        } catch (err) {
          const msg = `Codex MCP remove failed: ${err instanceof Error ? err.message : String(err)}`;
          logger.warning(msg);
          errors.push(msg);
        }
      } else {
        uninstalled.push("codex");
      }
      continue;
    }

    if ("mcp" in descriptor && descriptor.mcp) {
      const mcpSpec = descriptor.mcp;
      const configPath =
        typeof mcpSpec.configPath === "function"
          ? mcpSpec.configPath("")
          : mcpSpec.configPath;

      try {
        await manageMcpConfig({
          agentName: "gateway",
          projectDir: "",
          configPath,
          format: mcpSpec.format,
          action: "unlink",
          dryRun: options?.dryRun,
          serverName: "obagents",
        });
        uninstalled.push(descriptor.key);
      } catch (err) {
        const msg = `Failed to uninstall gateway for ${descriptor.key}: ${err instanceof Error ? err.message : String(err)}`;
        logger.warning(msg);
        errors.push(msg);
      }
    }
  }

  return { uninstalled, errors };
}

export async function getGatewayStatus(projectDir?: string): Promise<GatewayStatusItem[]> {
  const dir = resolve(projectDir ?? process.cwd());
  const expectedBin = resolveBinaryCommand();
  const expectedArgs = ["serve"];
  const items: GatewayStatusItem[] = [];

  for (const descriptor of DESCRIPTORS) {
    const key = descriptor.key;
    const isGlobal = GLOBAL_CAPABLE_TARGETS.includes(key as any);

    if (key === "codex") {
      let isReg = false;
      try {
        await runCodexMcp(["mcp", "get", "obagents", "--scope", "user"], dir);
        isReg = true;
      } catch {
        isReg = false;
      }
      items.push({
        key,
        name: descriptor.name,
        status: isReg ? "registered" : "missing",
        global: true,
      });
      continue;
    }

    const hasMcp = "mcp" in descriptor && descriptor.mcp;
    if (hasMcp) {
      const mcpSpec = descriptor.mcp!;
      const configPath =
        typeof mcpSpec.configPath === "function"
          ? mcpSpec.configPath(dir)
          : mcpSpec.configPath;

      let status: "registered" | "missing" = "missing";
      if (fs.existsSync(configPath)) {
        try {
          const raw = await fs.readFile(configPath, "utf8");
          const config = parseJsonc(raw);
          const adapter = adapters[mcpSpec.format];
          if (adapter) {
            const res = adapter.checkRegistration(config, "obagents", expectedBin, expectedArgs);
            if (res.status === "in-sync") {
              status = "registered";
            }
          }
        } catch {
          status = "missing";
        }
      }

      items.push({
        key,
        name: descriptor.name,
        status,
        global: isGlobal,
      });
    } else {
      items.push({
        key,
        name: descriptor.name,
        status: "missing",
        global: isGlobal,
      });
    }
  }

  return items;
}
