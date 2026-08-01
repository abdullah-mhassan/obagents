import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { fs } from "../../src/utils/fs.js";
import { createAgent } from "../../src/vault/agent.js";
import { vaultGraph } from "../../src/vault/link-graph.js";

let tmpRoot: string;
let projectDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "obagents-lg-"));
  projectDir = join(tmpRoot, "project");
  overrideVaultRoot(tmpRoot);
  await fs.mkdir(projectDir, { recursive: true });
  // See tests/linkers/integration.test.ts for why this canonicalization is needed.
  projectDir = await realpath(projectDir);
  await createAgent("odba");
});

afterEach(async () => {
  overrideVaultRoot(null);
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("link-graph ownership", () => {
  it("linkAgentToProject writes both sides of the edge", async () => {
    await vaultGraph.link("odba", ["cursor", "claude-code"], projectDir);

    expect(await vaultGraph.getProjectsForAgent("odba")).toContain(projectDir);
    expect(await vaultGraph.getTargetsForAgent("odba", projectDir)).toEqual(expect.arrayContaining(["cursor", "claude-code"]));
    expect(await vaultGraph.getAgentsForProject(projectDir)).toContain("odba");
  });

  it("unlinkAgentFromProject removes both sides", async () => {
    await vaultGraph.link("odba", ["cursor"], projectDir);
    await vaultGraph.unlink("odba", ["cursor"], projectDir);

    expect(await vaultGraph.getProjectsForAgent("odba")).not.toContain(projectDir);
    expect(await vaultGraph.getAgentsForProject(projectDir)).not.toContain("odba");
  });

  it("setProjectActiveAgent writes the active agent", async () => {
    await vaultGraph.link("odba", ["cursor"], projectDir);
    await vaultGraph.setActiveAgentForProject(projectDir, "odba");
    expect(await vaultGraph.getActiveAgentForProject(projectDir)).toBe("odba");

    await vaultGraph.setActiveAgentForProject(projectDir, undefined);
    expect(await vaultGraph.getActiveAgentForProject(projectDir)).toBeUndefined();
  });

  it("read queries default to empty for unknown inputs", async () => {
    expect(await vaultGraph.getProjectsForAgent("ghost")).toEqual([]);
    expect(await vaultGraph.getAgentsForProject("/no/such/project")).toEqual([]);
    expect(await vaultGraph.getTargetsForAgent("ghost", projectDir)).toEqual([]);
  });

  it("updateLinkState atomically updates Registry, Agent Metadata, and Project Config", async () => {
    const { readRegistry } = await import("../../src/vault/registry.js");
    const { getAgentMeta } = await import("../../src/vault/metadata.js");
    const { getProjectConfig } = await import("../../src/vault/project.js");

    await vaultGraph.updateLinkState("odba", projectDir, ["cursor"], "link");

    const registry = await readRegistry();
    expect(registry.agents["odba"]?.targets).toContain("cursor");

    const meta = await getAgentMeta("odba");
    expect(meta?.links).toHaveLength(1);
    expect(meta?.links[0]?.targets).toEqual(["cursor"]);

    const config = await getProjectConfig(projectDir);
    expect(config.linkedAgents).toContain("odba");

    await vaultGraph.updateLinkState("odba", projectDir, ["cursor"], "unlink");

    const registryAfter = await readRegistry();
    expect(registryAfter.agents["odba"]?.targets).not.toContain("cursor");

    const metaAfter = await getAgentMeta("odba");
    expect(metaAfter?.links).toHaveLength(0);

    const configAfter = await getProjectConfig(projectDir);
    expect(configAfter.linkedAgents).not.toContain("odba");
  });

  it("updateLinkState rolls back project config and agent meta when registry write fails", async () => {
    const { vi } = await import("vitest");
    const registryModule = await import("../../src/vault/registry.js");
    const { getProjectConfig } = await import("../../src/vault/project.js");
    const { getAgentMeta } = await import("../../src/vault/metadata.js");

    const spy = vi.spyOn(registryModule, "updateRegistry").mockRejectedValueOnce(new Error("Registry Write Failure"));

    await expect(
      vaultGraph.updateLinkState("odba", projectDir, ["cursor"], "link")
    ).rejects.toThrow("Registry Write Failure");

    const config = await getProjectConfig(projectDir);
    expect(config.linkedAgents).not.toContain("odba");

    const meta = await getAgentMeta("odba");
    expect(meta?.links).toHaveLength(0);

    spy.mockRestore();
  });

  it("updateLinkState safely executes rollback when failure occurs before state capture", async () => {
    const { vi } = await import("vitest");
    const projectModule = await import("../../src/vault/project.js");

    const spy = vi.spyOn(projectModule.projectVault, "updateProjectConfig").mockRejectedValueOnce(new Error("Project Lock Error"));

    await expect(
      vaultGraph.updateLinkState("odba", projectDir, ["cursor"], "link")
    ).rejects.toThrow("Project Lock Error");

    spy.mockRestore();
  });
});

