import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useMemoryFileSystem, useNodeFileSystem } from "../../src/utils/fs.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { createAgent } from "../../src/vault/agent.js";
import { compileRoster } from "../../src/vault/roster.js";
import { vaultSyncEngine, VaultSyncEngine } from "../../src/vault/sync.js";
import { vaultGraph } from "../../src/vault/link-graph.js";
import { TargetAdapterEngine } from "../../src/linker/engine.js";
import { createMapper } from "../../src/linker/mappers/base.js";
import { DESCRIPTORS } from "../../src/linker/mappers/declarations.js";
import { join } from "node:path";
import type { LinkContext } from "../../src/linker/types.js";

function createFakeContext(agentName: string, projectDir: string, compiledContent: string): LinkContext {
  return {
    agentName,
    projectDir,
    targets: [],
    async getRosterContent() {
      return compiledContent;
    },
    async getPassiveContent() {
      return compiledContent;
    },
    async getAgentMcpConfig() {
      return { command: "obagents", args: ["serve", agentName] };
    }
  };
}

describe("CLI Commands: activate (In-Memory)", () => {
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

  it("activates an agent and generates the hive roster file", async () => {
    // Link and activate dev-agent for the project directory first
    await vaultGraph.link("dev-agent", [], projectDir);
    await vaultGraph.setActiveAgentForProject(projectDir, "dev-agent");

    const rosterContent = await compileRoster(projectDir, ["dev-agent"], "dev-agent");
    const context = createFakeContext("dev-agent", projectDir, rosterContent);
    const cursorDescriptor = DESCRIPTORS.find((d) => d.key === "cursor")!;
    const adapter = createMapper(cursorDescriptor);
    const result = await adapter.apply(context, { force: true });
    
    expect(result.action).toBe("created");
    const cursorFile = join(projectDir, ".cursor/rules/obagents.mdc");
    expect(memFS.existsSync(cursorFile)).toBe(true);
    const content = await memFS.readFile(cursorFile);
    expect(content).toContain("dev-agent");
  });

  it("refuses to activate an agent with no linked targets (no phantom claude-code injection)", async () => {
    await vaultGraph.link("dev-agent", [], projectDir);

    await expect(vaultSyncEngine.activateAgent("dev-agent", projectDir)).rejects.toThrow(
      /no linked targets/i,
    );

    expect(memFS.existsSync(join(projectDir, "CLAUDE.md"))).toBe(false);
    expect(memFS.existsSync(join(projectDir, ".cursor/rules/obagents.mdc"))).toBe(false);
    expect(await vaultGraph.getActiveAgentForProject(projectDir)).toBe("dev-agent");
  });

  it("keeps the previous Active Runtime Agent when target writes fail", async () => {
    await createAgent("other-agent");
    await vaultGraph.link("dev-agent", ["cursor"], projectDir);
    await vaultGraph.link("other-agent", ["cursor"], projectDir);
    await vaultGraph.setActiveAgentForProject(projectDir, "other-agent");

    const failing = new TargetAdapterEngine();
    vi.spyOn(failing, "applyTargets").mockRejectedValue(new Error("Target write failed"));
    const engine = new VaultSyncEngine(failing, vaultGraph);

    await expect(engine.activateAgent("dev-agent", projectDir)).rejects.toThrow(
      "Target write failed",
    );
    expect(await vaultGraph.getActiveAgentForProject(projectDir)).toBe("other-agent");
  });

  it("activates an agent with valid targets, writing content before persisting the Active Runtime Agent", async () => {
    await vaultGraph.link("dev-agent", ["cursor"], projectDir);

    await vaultSyncEngine.activateAgent("dev-agent", projectDir);

    const cursorFile = join(projectDir, ".cursor/rules/obagents.mdc");
    expect(memFS.existsSync(cursorFile)).toBe(true);
    const content = await memFS.readFile(cursorFile);
    expect(content).toContain('agent="dev-agent"');
    expect(await vaultGraph.getActiveAgentForProject(projectDir)).toBe("dev-agent");
  });

  it("does not change the Active Runtime Agent on a dry-run activation", async () => {
    await createAgent("other-agent");
    await vaultGraph.link("dev-agent", ["cursor"], projectDir);
    await vaultGraph.link("other-agent", ["cursor"], projectDir);
    await vaultGraph.setActiveAgentForProject(projectDir, "other-agent");

    await vaultSyncEngine.activateAgent("dev-agent", projectDir, { dryRun: true });

    expect(await vaultGraph.getActiveAgentForProject(projectDir)).toBe("other-agent");
    expect(memFS.existsSync(join(projectDir, ".cursor/rules/obagents.mdc"))).toBe(false);
  });

  it("refuses to activate an agent with no linked targets even under dry-run", async () => {
    await vaultGraph.link("dev-agent", [], projectDir);

    await expect(
      vaultSyncEngine.activateAgent("dev-agent", projectDir, { dryRun: true }),
    ).rejects.toThrow(/no linked targets/i);
  });
});

