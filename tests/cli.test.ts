import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createCreateCommand, sanitizeName } from "../src/commands/create.js";
import { createListCommand } from "../src/commands/list.js";
import { createDeleteCommand } from "../src/commands/delete.js";
import { overrideVaultRoot, getAgentDir } from "../src/utils/paths.js";
import { listAgents, createAgent } from "../src/vault/agent.js";

import * as loggerModule from "../src/utils/logger.js";
const logger = loggerModule.logger;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

let tmpRoot: string;

function runCommand(command: Command, args: string[]): Promise<void> {
  return command.parseAsync(args, { from: "user" });
}

describe("create command", () => {
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "obagents-cli-test-"));
    overrideVaultRoot(tmpRoot);
  });

  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates an agent from a valid name", async () => {
    const command = createCreateCommand();
    await runCommand(command, ["test-agent"]);

    const agents = await listAgents();
    expect(agents.map((a) => a.name)).toContain("test-agent");
  });

  it("rejects a name that sanitizes to empty", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const command = createCreateCommand();
    await runCommand(command, ["!!!"]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("sanitizes names to lowercase alphanumerics", () => {
    expect(sanitizeName("MyAgent")).toBe("myagent");
    expect(sanitizeName("My Agent")).toBe("myagent");
  });

  it("sanitizeName strips a leading @ identically to MCP validation", () => {
    expect(sanitizeName("@my-agent")).toBe("my-agent");
    expect(sanitizeName("@My-Agent")).toBe("my-agent");
  });

  it("creates an agent from an @-prefixed name", async () => {
    const command = createCreateCommand();
    await runCommand(command, ["@test-agent"]);

    const agents = await listAgents();
    expect(agents.map((a) => a.name)).toContain("test-agent");
  });

  it("creates an agent from a template", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const templateDir = join(tmpRoot, "mock-template");
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(templateDir, "SOUL.md"), "Mock Soul");

    const command = createCreateCommand();
    await runCommand(command, ["template-agent", "--template", templateDir]);

    const { readFile } = await import("node:fs/promises");
    const soulPath = join(getAgentDir("template-agent"), "SOUL.md");
    const soulContent = await readFile(soulPath, "utf-8");
    // Persona content from the custom template is preserved,
    expect(soulContent).toContain("Mock Soul");
    // but Core Directives + persistence discipline are always appended so
    // custom-template agents can't silently opt out of memory discipline.
    expect(soulContent).toContain("<!-- obagents:core-directives v1 -->");
    expect(soulContent).toContain("Persist learnings at milestones, unprompted.");
  });

  it("substitutes a --description flag into the persona", async () => {
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const templateDir = join(tmpRoot, "desc-template");
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(templateDir, "SOUL.md"), "You are {{AGENT_NAME}} — {{AGENT_DESCRIPTION}}.");

    const command = createCreateCommand();
    await runCommand(command, ["desc-agent", "--template", templateDir, "--description", "Database specialist"]);

    const soul = await readFile(join(getAgentDir("desc-agent"), "SOUL.md"), "utf-8");
    expect(soul).toContain("You are desc-agent — Database specialist.");
  });

  it("creates an agent from a built-in archetype name", async () => {
    const { readFile } = await import("node:fs/promises");
    const command = createCreateCommand();
    await runCommand(command, ["engineer-agent", "--template", "engineer"]);

    for (const file of ["SOUL.md", "MEMORY.md", "USER.md"]) {
      expect(await exists(join(getAgentDir("engineer-agent"), file))).toBe(true);
    }

    const soul = await readFile(join(getAgentDir("engineer-agent"), "SOUL.md"), "utf-8");
    // Name and description are substituted into the archetype persona.
    expect(soul).toContain("# engineer-agent");
    expect(soul).toContain("A highly capable AI assistant.");
    // Archetype skeletons carry the role-specific sections...
    expect(soul).toContain("## Responsibilities");
    expect(soul).toContain("## Boundaries");
    // ...and Core Directives are enforced so archetype agents can't opt out.
    expect(soul).toContain("<!-- obagents:core-directives v1 -->");
    expect(soul).toContain("Persist learnings at milestones, unprompted.");

    const memory = await readFile(join(getAgentDir("engineer-agent"), "MEMORY.md"), "utf-8");
    expect(memory).toContain("# Working Memory");
    expect(memory).toContain("## Current objective");

    const user = await readFile(join(getAgentDir("engineer-agent"), "USER.md"), "utf-8");
    expect(user).toContain("# User Context");
    expect(user).toContain("## Preferences");
  });

  it("fails with an error naming the archetypes for an unknown template value", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const command = createCreateCommand();
    await runCommand(command, ["bad-agent", "--template", "no-such-archetype"]);

    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(messages).toContain("engineer");
    expect(messages).toContain("designer");
    expect(messages).toContain("copywriter");
    expect(messages).toContain("orchestrator");
    expect(await exists(getAgentDir("bad-agent"))).toBe(false);
  });
});

describe("list command", () => {
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "obagents-cli-list-"));
    overrideVaultRoot(tmpRoot);
  });

  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reports no agents when vault is empty", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const command = createListCommand();
    await runCommand(command, []);
    expect(infoSpy).toHaveBeenCalled();
  });

  it("lists created agents", async () => {
    const rawSpy = vi.spyOn(logger, "raw").mockImplementation(() => {});
    await createAgent("alpha");
    await createAgent("beta");
    const command = createListCommand();
    const program = new Command();
    program.addCommand(command);
    await runCommand(program, ["list"]);
    const calls = rawSpy.mock.calls.map((c) => String(c[0]));
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("alpha"),
        expect.stringContaining("beta"),
      ]),
    );
  });
});

describe("delete command", () => {
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "obagents-cli-del-"));
    overrideVaultRoot(tmpRoot);
  });

  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("deletes an existing agent with --yes flag", async () => {
    await createAgent("victim");
    expect(await exists(getAgentDir("victim"))).toBe(true);

    const successSpy = vi.spyOn(logger, "success").mockImplementation(() => {});
    const command = createDeleteCommand();
    const program = new Command();
    program.addCommand(command);
    await runCommand(program, ["delete", "victim", "--yes"]);
    expect(successSpy).toHaveBeenCalled();
    expect(await listAgents()).toEqual([]);
  });

  it("errors when agent does not exist", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const command = createDeleteCommand();
    const program = new Command();
    program.addCommand(command);
    await runCommand(program, ["delete", "ghost"]);
    expect(errorSpy).toHaveBeenCalled();
  });
});