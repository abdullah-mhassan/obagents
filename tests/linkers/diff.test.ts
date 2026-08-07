import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useMemoryFileSystem, useNodeFileSystem, fs } from "../../src/utils/fs.js";
import { diffProject, fixDrift, unifiedDiff } from "../../src/linker/diff.js";
import { createMapper } from "../../src/linker/mappers/base.js";
import { DESCRIPTORS } from "../../src/linker/mappers/declarations.js";
import { compileTeamRoster } from "../../src/vault/roster.js";
import { vaultSyncEngine, listUnlinkTargets } from "../../src/vault/sync.js";
import { vaultGraph } from "../../src/vault/link-graph.js";
import { targetAdapterEngine } from "../../src/linker/engine.js";
import { parse, stringify } from "yaml";

import { createAgent } from "../../src/vault/agent.js";
import { overrideVaultRoot, pathResolver } from "../../src/utils/paths.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

function spawnExited(code: number): EventEmitter {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", code));
  return child;
}

const genericMapper = createMapper(DESCRIPTORS.find((d) => d.key === "generic")!);
const PROJECT = "/virtual/project";

async function seedLinkedProject(targets: string[] = ["generic"]): Promise<void> {
  await vaultSyncEngine.linkAgent("odba", { targets, projectDir: PROJECT });
}

// Legacy/non-core targets are unlink-only: they can no longer be linked via
// linkAgent, but their retained DESCRIPTOR/mapper surface must still be diffable
// (the unlink-cleanup workflow inspects drift on them). Seed those at the mapper
// + link-graph level to exercise diff/check-drift without the core link boundary.
async function seedLinkedGraph(target: string): Promise<void> {
  await targetAdapterEngine.applyTarget("odba", PROJECT, target, { dryRun: false });
  await vaultGraph.link("odba", [target], PROJECT);
}

async function reapplyGraph(target: string): Promise<void> {
  await targetAdapterEngine.applyTarget("odba", PROJECT, target, { dryRun: false, force: true });
}

describe("project drift diff", () => {
  beforeEach(async () => {
    useMemoryFileSystem();
    overrideVaultRoot("/virtual/vault");
    pathResolver.setHomeDir("/virtual/home");
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => spawnExited(0) as any);
    await createAgent("odba");
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
    pathResolver.reset();
  });

  it("reports in-sync when the linked file matches the compiled roster", async () => {
    await seedLinkedProject(["generic"]);

    const { targets } = await diffProject(PROJECT);
    const generic = targets.find((t) => t.key === "generic");
    expect(generic?.status).toBe("in-sync");
    expect(generic?.diff).toBeUndefined();
  });

  it("ignores the generated timestamp in the start marker", async () => {
    await seedLinkedProject(["generic"]);
    const path = genericMapper.filePath!(PROJECT);
    const original = await fs.readFile(path, "utf8");
    const retimed = original.replace(/generated="[^"]*"/, 'generated="1999-01-01T00:00:00.000Z"');
    await fs.writeFile(path, retimed, "utf8");

    const { targets } = await diffProject(PROJECT);
    expect(targets.find((t) => t.key === "generic")?.status).toBe("in-sync");
  });

  it("reports drifted with a diff when the block content changes", async () => {
    await seedLinkedProject(["generic"]);
    const path = genericMapper.filePath!(PROJECT);
    const tampered = (await fs.readFile(path, "utf8")).replace("Hive", "Squad");
    await fs.writeFile(path, tampered, "utf8");

    const { targets } = await diffProject(PROJECT);
    const generic = targets.find((t) => t.key === "generic");
    expect(generic?.status).toBe("drifted");
    expect(generic?.diff).toContain("- # 🛡️ OB Agents Squad");
    expect(generic?.diff).toContain("+ # 🛡️ OB Agents Hive");
  });

  it("reports missing when the file has no OB Agents block", async () => {
    await seedLinkedProject(["generic"]);
    await fs.writeFile(genericMapper.filePath!(PROJECT), "# just a plain file\n", "utf8");

    const { targets } = await diffProject(PROJECT);
    expect(targets.find((t) => t.key === "generic")?.status).toBe("missing");
  });

  it("inspects ONLY registered targets for the active agent and ignores unrelated files on disk", async () => {
    await seedLinkedProject(["generic"]);
    await fs.writeFile(join(PROJECT, "CLAUDE.md"), "# Unrelated file", "utf8");

    const { targets } = await diffProject(PROJECT);
    expect(targets.map((t) => t.key)).toEqual(["generic"]);
    expect(targets.every((t) => t.key !== "claude-code")).toBe(true);
  });

  it("validates MCP server registration for global MCP targets (cursor)", async () => {
    pathResolver.setHomeDir("/virtual/home");
    await seedLinkedProject(["cursor"]);
    const mcpPath = pathResolver.getCursorMcpPath();

    let res = await diffProject(PROJECT);
    expect(res.targets.find((t) => t.key === "cursor")?.status).toBe("in-sync");

    const raw = await fs.readFile(mcpPath, "utf8");
    const mcpConfig = JSON.parse(raw);
    mcpConfig.mcpServers.obagents.args = ["wrong-arg"];
    await fs.writeFile(mcpPath, JSON.stringify(mcpConfig), "utf8");

    res = await diffProject(PROJECT);
    expect(res.targets.find((t) => t.key === "cursor")?.status).toBe("drifted");

    await fs.rm(mcpPath, { force: true });
    res = await diffProject(PROJECT);
    expect(res.targets.find((t) => t.key === "cursor")?.status).toBe("drifted");
    pathResolver.reset();
  });

  it("validates MCP server registration for project-only MCP targets (kilo)", async () => {
    expect(listUnlinkTargets()).toContain("kilo"); // kilo remains unlink-cleanup-only (legacy)
    await seedLinkedGraph("kilo");
    const mcpPath = join(PROJECT, "kilo.json");

    let res = await diffProject(PROJECT);
    expect(res.targets.find((t) => t.key === "kilo")?.status).toBe("in-sync");

    const raw = await fs.readFile(mcpPath, "utf8");
    const mcpConfig = JSON.parse(raw);
    mcpConfig.mcpServers.obagents.args = ["wrong-arg"];
    await fs.writeFile(mcpPath, JSON.stringify(mcpConfig), "utf8");

    res = await diffProject(PROJECT);
    expect(res.targets.find((t) => t.key === "kilo")?.status).toBe("drifted");

    await fs.rm(mcpPath, { force: true });
    res = await diffProject(PROJECT);
    expect(res.targets.find((t) => t.key === "kilo")?.status).toBe("drifted");
  });
});

describe("fixDrift", () => {
  beforeEach(async () => {
    useMemoryFileSystem();
    overrideVaultRoot("/virtual/vault");
    await createAgent("odba");
  });
  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
  });

  it("re-links drifted targets back into sync", async () => {
    await vaultSyncEngine.linkAgent("odba", { targets: ["generic"], projectDir: PROJECT });

    const path = genericMapper.filePath!(PROJECT);
    await fs.writeFile(path, (await fs.readFile(path, "utf8")).replace("Hive", "Squad"), "utf8");

    const before = await diffProject(PROJECT);
    expect(before.targets.find((t) => t.key === "generic")?.status).toBe("drifted");

    const { fixed } = await fixDrift(PROJECT);
    expect(fixed).toContain("generic");

    const after = await diffProject(PROJECT);
    expect(after.targets.find((t) => t.key === "generic")?.status).toBe("in-sync");
  });

  it("does nothing when everything is already in sync", async () => {
    await vaultSyncEngine.linkAgent("odba", { targets: ["generic"], projectDir: PROJECT });

    const { fixed } = await fixDrift(PROJECT);
    expect(fixed).toHaveLength(0);
  });
});


describe("aider drift (artifact-level)", () => {
  beforeEach(async () => {
    useMemoryFileSystem();
    overrideVaultRoot("/virtual/vault");
    await createAgent("odba");
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
  });

  const aiderConfigPath = () => join(PROJECT, ".aider.conf.yml");

  it("reports in-sync when the aider config read list matches the agent's core paths", async () => {
    await seedLinkedGraph("aider");

    const { targets } = await diffProject(PROJECT);
    const aider = targets.find((t) => t.key === "aider");
    expect(aider?.status).toBe("in-sync");
    expect(aider?.filePath).toBe(aiderConfigPath());
  });

  it("reports drifted when a core path is removed from the read list and mapper re-apply repairs it", async () => {
    await seedLinkedGraph("aider");
    const configPath = aiderConfigPath();
    const parsed = parse(await fs.readFile(configPath, "utf8"));
    parsed.read = (parsed.read as string[]).slice(1);
    await fs.writeFile(configPath, stringify(parsed), "utf8");

    const before = await diffProject(PROJECT);
    const drifted = before.targets.find((t) => t.key === "aider");
    expect(drifted?.status).toBe("drifted");

    // aider is non-core (unlink-only), so fixDrift (which re-links via linkAgent)
    // is out of scope — but the retained mapper can still re-apply its artifact.
    await reapplyGraph("aider");

    const after = await diffProject(PROJECT);
    expect(after.targets.find((t) => t.key === "aider")?.status).toBe("in-sync");
  });

  it("does not rewrite an in-sync aider config on mapper re-apply", async () => {
    await seedLinkedGraph("aider");
    const configPath = aiderConfigPath();
    const before = await fs.readFile(configPath, "utf8");

    await reapplyGraph("aider");
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
  });

  it("ignores extra user paths in the read list", async () => {
    await seedLinkedGraph("aider");
    const configPath = aiderConfigPath();
    const parsed = parse(await fs.readFile(configPath, "utf8"));
    parsed.read = [...(parsed.read as string[]), "src/notes.md"];
    await fs.writeFile(configPath, stringify(parsed), "utf8");

    const { targets } = await diffProject(PROJECT);
    expect(targets.find((t) => t.key === "aider")?.status).toBe("in-sync");
  });

  it("checks Codex CLI MCP server registration drift via checkDrift for codex", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);
    await seedLinkedProject(["codex"]);

    const res1 = await diffProject(PROJECT);
    expect(res1.targets.find((t) => t.key === "codex")?.status).toBe("in-sync");

    spawnMock.mockImplementation(() => spawnExited(1) as any);
    const res2 = await diffProject(PROJECT);
    const codexDrift = res2.targets.find((t) => t.key === "codex");
    expect(codexDrift?.status).toBe("drifted");
    expect(codexDrift?.diff).toContain("Codex MCP server 'obagents' is not registered");
  });

  it("handles absent global MCP config file cleanly without reporting false missing drift status when artifact is present", async () => {
    spawnMock.mockImplementation(() => spawnExited(0) as any);
    await seedLinkedProject(["cursor"]);
    const cursorConfigPath = pathResolver.getCursorMcpPath();
    if (fs.existsSync(cursorConfigPath)) {
      await fs.rm(cursorConfigPath, { force: true });
    }

    const { targets } = await diffProject(PROJECT);
    const cursor = targets.find((t) => t.key === "cursor");
    expect(cursor?.status).toBe("drifted");
    expect(cursor?.diff).toContain("missing");
  });
});

describe("unifiedDiff", () => {
  it("marks removed, added, and unchanged lines", () => {
    const out = unifiedDiff("a\nb\nc", "a\nx\nc");
    expect(out).toContain("  a");
    expect(out).toContain("- b");
    expect(out).toContain("+ x");
    expect(out).toContain("  c");
  });

  it("returns only context lines when inputs are identical", () => {
    const out = unifiedDiff("same\ntext", "same\ntext");
    expect(out).toBe("  same\n  text");
  });
});
