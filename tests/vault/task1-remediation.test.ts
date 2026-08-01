import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { useMemoryFileSystem, useNodeFileSystem, fs } from "../../src/utils/fs.js";
import { overrideVaultRoot, getAgentMetaPath } from "../../src/utils/paths.js";
import { createAgent } from "../../src/vault/agent.js";
import { vaultGraph } from "../../src/vault/link-graph.js";
import { getAgentMeta, migrateAgentMeta } from "../../src/vault/metadata.js";
import { vaultSyncEngine, vaultSync } from "../../src/vault/sync.js";

const linkAgent = vaultSyncEngine.linkAgent.bind(vaultSyncEngine);
const syncAgentAcrossProjects = vaultSyncEngine.syncAgentAcrossProjects.bind(vaultSyncEngine);

import { getProjectConfig } from "../../src/vault/project.js";
import { targetAdapterEngine } from "../../src/linker/engine.js";
import { deleteAgent, getAgentDeletePlan, agentExists } from "../../src/vault/agent.js";

const VAULT = "/virtual/vault";
const PROJ_A = "/virtual/project-a";
const PROJ_B = "/virtual/project-b";

describe("Task 1 Sequential Remediation: Per-project target mapping & migration", () => {
  beforeEach(async () => {
    useMemoryFileSystem();
    overrideVaultRoot(VAULT);
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
  });

  it("migrates legacy agent metadata deterministically and discards stale targets with warning", async () => {
    await createAgent("legacy-agent");

    const metaPath = getAgentMetaPath("legacy-agent");
    const legacyMeta = {
      name: "legacy-agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      linkedTargets: ["cursor", "roo"],
      linkedProjects: [PROJ_A, PROJ_B],
    };
    await fs.writeFile(metaPath, JSON.stringify(legacyMeta, null, 2), "utf8");

    const migrationResult = await migrateAgentMeta("legacy-agent");
    expect(migrationResult.warnings).toEqual([]);

    const diskRaw = JSON.parse(await fs.readFile(metaPath, "utf8"));
    expect(diskRaw.linkedTargets).toBeUndefined();
    expect(diskRaw.linkedProjects).toBeUndefined();
    expect(diskRaw.links).toHaveLength(2);
    expect(diskRaw.links).toEqual([
      { projectDir: PROJ_A, targets: ["cursor", "roo"] },
      { projectDir: PROJ_B, targets: ["cursor", "roo"] },
    ]);

    // Test stale legacy targets with no project association
    await createAgent("stale-agent");
    const staleMetaPath = getAgentMetaPath("stale-agent");
    const staleLegacyMeta = {
      name: "stale-agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      linkedTargets: ["cursor"],
      linkedProjects: [],
    };
    await fs.writeFile(staleMetaPath, JSON.stringify(staleLegacyMeta, null, 2), "utf8");

    const staleMigration = await migrateAgentMeta("stale-agent");
    expect(staleMigration.warnings).toHaveLength(1);
    expect(staleMigration.warnings[0]).toContain("Discarded stale target(s) [cursor]");

    const staleDiskRaw = JSON.parse(await fs.readFile(staleMetaPath, "utf8"));
    expect(staleDiskRaw.links).toEqual([]);
  });

  it("maintains distinct target sets across multiple projects for a single agent", async () => {
    await createAgent("multi-agent");

    await vaultGraph.link("multi-agent", ["cursor"], PROJ_A);
    await vaultGraph.link("multi-agent", ["windsurf"], PROJ_B);

    const targetsA = await vaultGraph.getTargetsForAgent("multi-agent", PROJ_A);
    const targetsB = await vaultGraph.getTargetsForAgent("multi-agent", PROJ_B);

    expect(targetsA).toEqual(["cursor"]);
    expect(targetsB).toEqual(["windsurf"]);

    const projects = await vaultGraph.getProjectsForAgent("multi-agent");
    expect(projects).toEqual([PROJ_A, PROJ_B]);
  });

  it("handles partial unlink by retaining remaining targets and project membership", async () => {
    await createAgent("partial-agent");

    await vaultGraph.link("partial-agent", ["cursor", "roo"], PROJ_A);

    let config = await getProjectConfig(PROJ_A);
    expect(config.linkedAgents).toContain("partial-agent");
    expect(config.activeAgent).toBe("partial-agent");

    // Unlink only 'cursor'
    await vaultGraph.unlink("partial-agent", ["cursor"], PROJ_A);

    const targetsAfterPartial = await vaultGraph.getTargetsForAgent("partial-agent", PROJ_A);
    expect(targetsAfterPartial).toEqual(["roo"]);

    config = await getProjectConfig(PROJ_A);
    expect(config.linkedAgents).toContain("partial-agent");
    expect(config.activeAgent).toBe("partial-agent");

    // Unlink remaining 'roo'
    await vaultGraph.unlink("partial-agent", ["roo"], PROJ_A);

    const targetsAfterFull = await vaultGraph.getTargetsForAgent("partial-agent", PROJ_A);
    expect(targetsAfterFull).toEqual([]);

    config = await getProjectConfig(PROJ_A);
    expect(config.linkedAgents).not.toContain("partial-agent");
    expect(config.activeAgent).toBeUndefined();
  });

  it("replays project-specific targets during sync without cross-project target pollution", async () => {
    await createAgent("sync-agent");

    await linkAgent("sync-agent", { targets: ["generic"], projectDir: PROJ_A });
    await linkAgent("sync-agent", { targets: ["windsurf"], projectDir: PROJ_B });

    const syncResult = await syncAgentAcrossProjects("sync-agent");
    expect(syncResult.status).toBe("success");

    const targetsA = await vaultGraph.getTargetsForAgent("sync-agent", PROJ_A);
    const targetsB = await vaultGraph.getTargetsForAgent("sync-agent", PROJ_B);

    expect(targetsA).toEqual(["generic"]);
    expect(targetsB).toEqual(["windsurf"]);
  });

  it("ensures activation uses only current-project targets", async () => {
    await createAgent("act-agent");

    await linkAgent("act-agent", { targets: ["generic"], projectDir: PROJ_A });
    await linkAgent("act-agent", { targets: ["windsurf"], projectDir: PROJ_B });

    await vaultGraph.setActiveAgentForProject(PROJ_A, "act-agent");
    const active = await vaultGraph.getActiveAgentForProject(PROJ_A);
    expect(active).toBe("act-agent");

    const activeTargets = await vaultGraph.getTargetsForAgent(active!, PROJ_A);
    expect(activeTargets).toEqual(["generic"]);
    expect(activeTargets).not.toContain("windsurf");
  });

  describe("Transactional failure-safety & deletion redesign", () => {
    it("linkAgent fails closed and leaves metadata unchanged when adapter errors", async () => {
      await createAgent("fail-link-agent");

      // Spy/mock an adapter to throw an error
      const adapter = targetAdapterEngine.getAdapter("generic");
      const originalApply = adapter.apply;
      adapter.apply = async () => {
        throw new Error("Adapter disk write failed");
      };

      try {
        await expect(
          vaultSync.linkAgent("fail-link-agent", { targets: ["generic"], projectDir: PROJ_A }),
        ).rejects.toThrow("Adapter disk write failed");

        // Verify metadata was NOT updated
        const targets = await vaultGraph.getTargetsForAgent("fail-link-agent", PROJ_A);
        expect(targets).toEqual([]);
      } finally {
        adapter.apply = originalApply;
      }
    });

    it("unlinkAgent fails closed and leaves metadata unchanged when adapter errors", async () => {
      await createAgent("fail-unlink-agent");
      await vaultSync.linkAgent("fail-unlink-agent", { targets: ["generic"], projectDir: PROJ_A });

      const adapter = targetAdapterEngine.getAdapter("generic");
      const originalRemove = adapter.remove;
      adapter.remove = async () => {
        throw new Error("Adapter cleanup failed");
      };

      try {
        await expect(
          vaultSync.unlinkAgent("fail-unlink-agent", { targets: ["generic"], projectDir: PROJ_A }),
        ).rejects.toThrow("Adapter cleanup failed");

        // Verify metadata remains linked
        const targets = await vaultGraph.getTargetsForAgent("fail-unlink-agent", PROJ_A);
        expect(targets).toEqual(["generic"]);
      } finally {
        adapter.remove = originalRemove;
      }
    });

    it("deleteAgent fails closed and retains metadata if target cleanup fails", async () => {
      await createAgent("delete-fail-agent");
      await vaultSync.linkAgent("delete-fail-agent", { targets: ["generic"], projectDir: PROJ_A });

      const plan = await getAgentDeletePlan("delete-fail-agent");
      expect(plan.projects).toHaveLength(1);
      expect(plan.projects[0].targets).toEqual(["generic"]);

      const adapter = targetAdapterEngine.getAdapter("generic");
      const originalRemove = adapter.remove;
      adapter.remove = async () => {
        throw new Error("Target integration removal error");
      };

      try {
        await expect(deleteAgent("delete-fail-agent")).rejects.toThrow("Target integration removal error");

        // Metadata and vault directory must be retained
        expect(agentExists("delete-fail-agent")).toBe(true);
        const targets = await vaultGraph.getTargetsForAgent("delete-fail-agent", PROJ_A);
        expect(targets).toEqual(["generic"]);
      } finally {
        adapter.remove = originalRemove;
      }
    });

    it("deleteAgent cleans integrations across all projects and removes vault metadata on success", async () => {
      await createAgent("delete-success-agent");
      await vaultSync.linkAgent("delete-success-agent", { targets: ["generic"], projectDir: PROJ_A });
      await vaultSync.linkAgent("delete-success-agent", { targets: ["generic"], projectDir: PROJ_B });

      const deleted = await deleteAgent("delete-success-agent");
      expect(deleted).toBe(true);
      expect(agentExists("delete-success-agent")).toBe(false);

      const targetsA = await vaultGraph.getTargetsForAgent("delete-success-agent", PROJ_A);
      const targetsB = await vaultGraph.getTargetsForAgent("delete-success-agent", PROJ_B);
      expect(targetsA).toEqual([]);
      expect(targetsB).toEqual([]);
    });
  });
});
