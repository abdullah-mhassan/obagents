import { select } from "@inquirer/prompts";
import { resolve } from "node:path";
import { listAgents } from "../vault/agent.js";
import { sanitizeName } from "./create.js";
import { logger } from "../utils/logger.js";
import { findProjectRoot } from "../vault/project.js";
import { vaultSyncEngine } from "../vault/sync.js";

/**
 * Expected (user-facing) command failure. Caught by `runCommand` and reported
 * with `logger.error` + a non-zero exit, without a stack trace. Throw it from
 * anywhere inside a command action instead of manually setting `process.exitCode`.
 */
export class CommandError extends Error {}

/**
 * Abort the current command with a clean, user-facing error message.
 */
export function fail(message: string): never {
  throw new CommandError(message);
}

/**
 * Wrap a commander action so every command shares one error shell: coerce the
 * thrown value to a message, log it, and set `process.exitCode = 1`. Removes the
 * duplicated try/catch that lived in all 11 command files.
 */
export function runCommand<T extends unknown[]>(
  action: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return async (...args: T): Promise<void> => {
    try {
      await action(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(message);
      process.exitCode = 1;
    }
  };
}

/**
 * The repeated "if no agent arg, list agents and prompt" block, factored out.
 * `prompt` lets each command phrase its own question. Throws `CommandError`
 * (via `fail`) when the vault has no agents, so callers need no empty-check.
 */
export async function selectAgent(prompt = "Select an agent:"): Promise<string> {
  const agents = await listAgents();
  if (agents.length === 0) fail("No agents found in vault.");
  const name = await select({
    message: prompt,
    choices: agents.map((a) => ({ name: a.name, value: a.name })),
  });
  return sanitizeName(name);
}

export async function resolveProjectDir(agentName: string, options: { global?: boolean; project?: string }): Promise<string | undefined> {
  if (options.global) {
    return undefined;
  } else if (options.project) {
    return resolve(options.project);
  } else {
    const cwd = process.cwd();
    const root = findProjectRoot(cwd);
    if (root) {
      const linkedAgents = await vaultSyncEngine.getAgentsForProject(root);
      if (linkedAgents.includes(agentName)) {
        return root;
      }
    }
    return undefined;
  }
}

