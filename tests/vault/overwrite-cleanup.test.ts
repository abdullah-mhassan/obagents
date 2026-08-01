import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { useMemoryFileSystem, useNodeFileSystem, fs } from "../../src/utils/fs.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { createAgent, agentExists } from "../../src/vault/agent.js";
import { vaultGraph } from "../../src/vault/link-graph.js";
import { vaultSyncEngine } from "../../src/vault/sync.js";
import { projectVault } from "../../src/vault/project.js";
import { hasBlock } from "../../src/linker/markers.js";

const linkAgent = vaultSyncEngine.linkAgent.bind(vaultSyncEngine);

const VAULT = "/virtual/vault";
const PROJECT_A = "/virtual/project-a";
const PROJECT_B = "/virtual/project-b";

describe("createAgent --force cleanup of the overwritten agent", () => {
  beforeEach(async () => {
    useMemoryFileSystem();
    overrideVaultRoot(VAULT);
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
  });

  it("removes the old agent's integrations, roster entry, and link graph edges before overwriting", async () => {
    await createAgent("alpha");
    await createAgent("beta");
    await linkAgent("alpha", { targets: ["generic"], projectDir: PROJECT_A });
    await linkAgent("beta", { targets: ["generic"], projectDir: PROJECT_A });

    const fileA = join(PROJECT_A, "AGENT.md");
    expect(hasBlock(await fs.readFile(fileA, "utf8"), "alpha")).toBe(true);

    await createAgent("alpha", { force: true });

    const roster = await fs.readFile(fileA, "utf8");
    expect(hasBlock(roster, "alpha")).toBe(false);
    expect(hasBlock(roster, "beta")).toBe(true);

    const config = await projectVault.getProjectConfig(PROJECT_A);
    expect(config.linkedAgents).not.toContain("alpha");
    expect(config.linkedAgents).toContain("beta");
    expect(config.activeAgent).not.toBe("alpha");

    expect(await vaultGraph.getProjectsForAgent("alpha")).toEqual([]);
    expect(await vaultGraph.getTargetsForAgent("alpha", PROJECT_A)).toEqual([]);
    expect(agentExists("alpha")).toBe(true);
  });

  it("cleans every linked project, including ones where the overwritten agent was the only member", async () => {
    await createAgent("solo");
    await linkAgent("solo", { targets: ["generic"], projectDir: PROJECT_A });
    await linkAgent("solo", { targets: ["generic"], projectDir: PROJECT_B });

    await createAgent("solo", { force: true });

    for (const projectDir of [PROJECT_A, PROJECT_B]) {
      const filePath = join(projectDir, "AGENT.md");
      if (fs.existsSync(filePath)) {
        expect(hasBlock(await fs.readFile(filePath, "utf8"), "solo")).toBe(false);
      }
    }

    expect((await projectVault.getProjectConfig(PROJECT_A)).linkedAgents).toEqual([]);
    expect((await projectVault.getProjectConfig(PROJECT_B)).linkedAgents).toEqual([]);
    expect(await vaultGraph.getProjectsForAgent("solo")).toEqual([]);
  });
});
