import { Command } from "commander";
import { pathToFileURL } from "node:url";
import { VERSION } from "./utils/constants.js";
import { logger } from "./utils/logger.js";
import { createCreateCommand } from "./commands/create.js";
import { createListCommand } from "./commands/list.js";
import { createDeleteCommand } from "./commands/delete.js";
import { createEditCommand } from "./commands/edit.js";
import { createLinkCommand } from "./commands/link.js";
import { createUnlinkCommand } from "./commands/unlink.js";
import { createDiffCommand } from "./commands/diff.js";
import { createSyncCommand } from "./commands/sync.js";

import { createConsolidateCommand } from "./commands/consolidate.js";
import { createServeCommand } from "./commands/serve.js";
import { createActivateCommand } from "./commands/activate.js";
import { createMemoryCommand } from "./commands/memory.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("obagents")
    .description("Local-first agent profile manager.")
    .version(VERSION);

  program.addCommand(createCreateCommand());
  program.addCommand(createListCommand());
  program.addCommand(createDeleteCommand());
  program.addCommand(createEditCommand());
  program.addCommand(createLinkCommand());
  program.addCommand(createUnlinkCommand());
  program.addCommand(createDiffCommand());
  program.addCommand(createSyncCommand());

  program.addCommand(createConsolidateCommand());
  program.addCommand(createServeCommand());
  program.addCommand(createActivateCommand());
  program.addCommand(createMemoryCommand());

  return program;
}

export function runProgram(program: Command): void {
  program.parseAsync(process.argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    process.exitCode = 1;
  });
}

import { realpathSync } from "node:fs";

function checkDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entryPath = realpathSync(process.argv[1]);
    return import.meta.url === pathToFileURL(entryPath).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (checkDirectExecution()) {
  runProgram(createProgram());
}