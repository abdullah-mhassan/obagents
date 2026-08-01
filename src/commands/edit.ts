import { Command } from "commander";
import { spawn } from "node:child_process";
import { EDITABLE_FILES, type EditableFileKey } from "../utils/constants.js";
import { platform } from "node:os";
import { select } from "@inquirer/prompts";
import { agentExists } from "../vault/agent.js";
import { sanitizeName } from "./create.js";
import { getCoreFilePath } from "../vault/project.js";
import { logger } from "../utils/logger.js";
import { runCommand, selectAgent, fail, resolveProjectDir } from "./runner.js";

const VALID_FILES = Object.keys(EDITABLE_FILES) as EditableFileKey[];

export function createEditCommand(): Command {
  const command = new Command("edit");

  command
    .argument("[name]", "The name of the agent.")
    .argument("[file]", `The file to edit (${VALID_FILES.join(", ")}).`)
    .option("-g, --global", "Target the vault instead of the current project.")
    .option("-p, --project <path>", "Target a specific project.")
    .action(
      runCommand(async (providedName: string | undefined, providedFile: string | undefined, options: { global?: boolean; project?: string }) => {
        const name = sanitizeName(providedName ?? (await selectAgent("Select an agent to edit:")));

        let file = providedFile;
        if (!file) {
          file = await select({
            message: "Select a file to edit:",
            choices: VALID_FILES.map(f => ({ name: f, value: f })),
          });
        }

        const key = file.toLowerCase() as EditableFileKey;
        if (!(key in EDITABLE_FILES)) {
          fail(`Invalid file "${file}". Valid options: ${VALID_FILES.join(", ")}.`);
        }

        if (!agentExists(name)) {
          fail(`Agent "${name}" does not exist.`);
        }

        const projectDir = await resolveProjectDir(name, options);

        const filePath = getCoreFilePath(name, EDITABLE_FILES[key], projectDir);
        const editor = resolveEditor();
        const editorArgs = [...parseEditorCommand(editor), filePath];
        logger.info(`Opening ${filePath} with ${editor}...`);

        await new Promise<void>((resolve, reject) => {
          const child = spawn(editorArgs[0]!, editorArgs.slice(1), { stdio: "inherit" });
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0 || code === null) {
              resolve();
            } else {
              reject(new Error(`Editor exited with code ${code}.`));
            }
          });
        });
      }),
    );

  return command;
}

export function resolveEditor(): string {
  const fallback = platform() === "win32" ? "notepad" : "nano";
  return process.env.EDITOR || fallback;
}

export function parseEditorCommand(editor: string): string[] {
  return editor.trim().split(/\s+/).filter(Boolean);
}