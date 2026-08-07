import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { useMemoryFileSystem, useNodeFileSystem } from "../../src/utils/fs.js";
import { vaultSyncEngine } from "../../src/vault/sync.js";

const linkAgent = vaultSyncEngine.linkAgent.bind(vaultSyncEngine);
const unlinkAgent = vaultSyncEngine.unlinkAgent.bind(vaultSyncEngine);

import { createUnlinkCommand } from "../../src/commands/unlink.js";
import { createLinkCommand } from "../../src/commands/link.js";
import { createAgent } from "../../src/vault/agent.js";
import { overrideVaultRoot, getAgentDir } from "../../src/utils/paths.js";
import { projectVault } from "../../src/vault/project.js";
import { RollbackFailedError } from "../../src/vault/sync.js";
import { join } from "node:path";
import { vi } from "vitest";

describe("CLI Commands: link and unlink (In-Memory)", () => {
  let memFS: any;
  const projectDir = "/virtual/project";
  const vaultRoot = "/virtual/vault";

  beforeEach(async () => {
    memFS = useMemoryFileSystem();
    overrideVaultRoot(vaultRoot);
    await createAgent("dev-agent");
    await memFS.mkdir(projectDir);
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
  });

  it("successfully links agent brain to Cursor config in-memory", async () => {
    const outcome = await linkAgent("dev-agent", {
      targets: ["cursor"],
      dryRun: false,
      projectDir,
    });

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].key).toBe("cursor");
    
    const cursorFile = join(projectDir, ".cursor/rules/obagents.mdc");
    expect(memFS.existsSync(cursorFile)).toBe(true);
    const content = await memFS.readFile(cursorFile);
    expect(content).toContain("agent=\"dev-agent\"");
  });

  it("link materializes the project-scoped memory in the agent's vault", async () => {
    await linkAgent("dev-agent", { targets: ["cursor"], dryRun: false, projectDir });

    const hash = projectVault.getProjectHash(projectDir);
    const scopedDir = join(getAgentDir("dev-agent"), "projects", hash);
    expect(memFS.existsSync(join(scopedDir, "MEMORY.md"))).toBe(true);
    expect(memFS.existsSync(join(scopedDir, "project.json"))).toBe(true);
  });

  it("dry-run link does not materialize the project-scoped memory", async () => {
    await linkAgent("dev-agent", { targets: ["cursor"], dryRun: true, projectDir });

    const hash = projectVault.getProjectHash(projectDir);
    expect(memFS.existsSync(join(getAgentDir("dev-agent"), "projects", hash))).toBe(false);
  });

  it("successfully unlinks agent from Cursor in-memory", async () => {
    // Write a mock link first
    await linkAgent("dev-agent", { targets: ["cursor"], dryRun: false, projectDir });
    
    const outcome = await unlinkAgent("dev-agent", {
      targets: ["cursor"],
      dryRun: false,
      projectDir,
    });

    expect(outcome.results).toHaveLength(1);
    const cursorFile = join(projectDir, ".cursor/rules/obagents.mdc");
    expect(memFS.existsSync(cursorFile)).toBe(false); // Cleaned completely
  });

  it("unlink --all removes every linked target for the agent", async () => {
    await linkAgent("dev-agent", { targets: ["cursor", "generic"], dryRun: false, projectDir });

    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const program = new Command();
      program.exitOverride();
      program.addCommand(createUnlinkCommand());
      process.exitCode = 0;
      await program.parseAsync(["unlink", "dev-agent", "--all"], { from: "user" });
    } finally {
      process.cwd = origCwd;
    }

    expect(process.exitCode).toBe(0);
    expect(memFS.existsSync(join(projectDir, ".cursor/rules/obagents.mdc"))).toBe(false);
    expect(memFS.existsSync(join(projectDir, "AGENT.md"))).toBe(false);
  });

  it("unlink --target and --all together is rejected", async () => {
    await linkAgent("dev-agent", { targets: ["cursor"], dryRun: false, projectDir });
    const cursorFile = join(projectDir, ".cursor/rules/obagents.mdc");

    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const program = new Command();
      program.exitOverride();
      program.addCommand(createUnlinkCommand());
      process.exitCode = 0;
      await program.parseAsync(["unlink", "dev-agent", "--target", "cursor", "--all"], { from: "user" });
    } finally {
      process.cwd = origCwd;
    }

    expect(process.exitCode).toBe(1);
    expect(memFS.existsSync(cursorFile)).toBe(true); // not cleaned
  });

  it("link command catches RollbackFailedError and sets exitCode to 1", async () => {
    vi.spyOn(vaultSyncEngine, "linkAgent").mockRejectedValueOnce(
      new RollbackFailedError(new Error("Apply failed"), ["cursor"], projectDir),
    );

    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const program = new Command();
      program.exitOverride();
      program.addCommand(createLinkCommand());
      process.exitCode = 0;
      await program.parseAsync(["link", "dev-agent", "--target", "cursor"], { from: "user" });
    } finally {
      process.cwd = origCwd;
      vi.restoreAllMocks();
    }

    expect(process.exitCode).toBe(1);
  });

  it("unlink command catches RollbackFailedError and sets exitCode to 1", async () => {
    vi.spyOn(vaultSyncEngine, "unlinkAgent").mockRejectedValueOnce(
      new RollbackFailedError(new Error("Remove failed"), ["cursor"], projectDir, "unlink"),
    );

    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const program = new Command();
      program.exitOverride();
      program.addCommand(createUnlinkCommand());
      process.exitCode = 0;
      await program.parseAsync(["unlink", "dev-agent", "--target", "cursor"], { from: "user" });
    } finally {
      process.cwd = origCwd;
      vi.restoreAllMocks();
    }

    expect(process.exitCode).toBe(1);
  });
});
