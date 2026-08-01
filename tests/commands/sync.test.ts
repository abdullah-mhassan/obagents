import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { useMemoryFileSystem, useNodeFileSystem, fs } from "../../src/utils/fs.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { createAgent } from "../../src/vault/agent.js";
import { vaultSyncEngine } from "../../src/vault/sync.js";

const linkAgent = vaultSyncEngine.linkAgent.bind(vaultSyncEngine);
const syncAgentAcrossProjects = vaultSyncEngine.syncAgentAcrossProjects.bind(vaultSyncEngine);

import { getAgentMeta } from "../../src/vault/metadata.js";
import { diffProject, fixDrift } from "../../src/linker/diff.js";

const VAULT = "/virtual/vault";
const PROJECT_A = "/virtual/proj-a";
const PROJECT_B = "/virtual/proj-b";

describe("sync (re-link across linkedProjects)", () => {
  beforeEach(async () => {
    useMemoryFileSystem();
    overrideVaultRoot(VAULT);
    await createAgent("odba");
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
  });

  it("records every linked project in the agent metadata", async () => {
    await linkAgent("odba", { targets: ["generic"], projectDir: PROJECT_A });
    await linkAgent("odba", { targets: ["generic"], projectDir: PROJECT_B });

    const meta = await getAgentMeta("odba");
    expect(meta?.links.map((l) => l.projectDir)).toEqual([PROJECT_A, PROJECT_B]);
    expect(meta?.links.flatMap((l) => l.targets)).toContain("generic");
  });

  it("re-links each registered project so drift is repaired", async () => {
    await linkAgent("odba", { targets: ["generic"], projectDir: PROJECT_A });
    await linkAgent("odba", { targets: ["generic"], projectDir: PROJECT_B });

    const fileA = join(PROJECT_A, "AGENT.md");
    await fs.writeFile(fileA, (await fs.readFile(fileA, "utf8")).replace("Hive", "Squad"), "utf8");
    expect((await diffProject(PROJECT_A)).targets.find((t) => t.key === "generic")?.status).toBe("drifted");

    const meta = await getAgentMeta("odba");
    await syncAgentAcrossProjects("odba");

    expect((await diffProject(PROJECT_A)).targets.find((t) => t.key === "generic")?.status).toBe("in-sync");
    expect((await diffProject(PROJECT_B)).targets.find((t) => t.key === "generic")?.status).toBe("in-sync");
  });

  it("returns structured outcome report from syncAgentAcrossProjects", async () => {
    await linkAgent("odba", { targets: ["generic"], projectDir: PROJECT_A });

    const report = await syncAgentAcrossProjects("odba");
    expect(report.status).toBe("success");
    if (report.status === "success") {
      expect(report.agent).toBe("odba");
      expect(report.syncedCount).toBe(1);
      expect(report.projects).toHaveLength(1);
      expect(report.projects[0].projectDir).toBe(PROJECT_A);
      expect(report.projects[0].results[0].target).toBe("generic");
      expect(report.projects[0].results[0].result.action).toBe("updated"); // Because it re-links
    }
  });

  it("fixDrift uses the active agent to recompile", async () => {
    await linkAgent("odba", { targets: ["generic"], projectDir: PROJECT_A });
    const fileA = join(PROJECT_A, "AGENT.md");
    await fs.writeFile(fileA, "# stripped\n", "utf8");
    expect((await diffProject(PROJECT_A)).targets.find((t) => t.key === "generic")?.status).toBe("missing");

    await fixDrift(PROJECT_A);
    expect((await diffProject(PROJECT_A)).targets.find((t) => t.key === "generic")?.status).toBe("in-sync");
  });
});
