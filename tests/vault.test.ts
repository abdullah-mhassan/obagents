import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, listAgents, deleteAgent, agentExists } from "../src/vault/agent.js";
import { getAgentMeta } from "../src/vault/metadata.js";
import { vaultGraph } from "../src/vault/link-graph.js";
import { getProjectConfig } from "../src/vault/project.js";
import { overrideVaultRoot, getAgentDir, getRegistryPath } from "../src/utils/paths.js";

let tmpRoot: string;

async function freshVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "obagents-test-"));
  overrideVaultRoot(dir);
  return dir;
}

describe("vault", () => {
  beforeEach(async () => {
    tmpRoot = await freshVault();
  });

  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe("createAgent", () => {
    it("creates agent dir with triad files, agent.json, and registry entry", async () => {
      const result = await createAgent("test-agent");

      expect(result.name).toBe("test-agent");
      expect(result.overwritten).toBe(false);

      for (const file of ["SOUL.md", "MEMORY.md", "USER.md", "agent.json"]) {
        await expect(access(join(getAgentDir("test-agent"), file))).resolves.toBeUndefined();
      }

      const meta = await getAgentMeta("test-agent");
      expect(meta?.name).toBe("test-agent");
      expect(meta?.links).toEqual([]);

      const registry = JSON.parse(await readFile(getRegistryPath(), "utf8"));
      expect(registry.agents["test-agent"]).toBeDefined();
      expect(registry.agents["test-agent"].createdAt).toBe(result.createdAt);
    });

    it("throws when agent already exists without --force", async () => {
      await createAgent("dupe-agent");
      await expect(createAgent("dupe-agent")).rejects.toThrow(/already exists/);
    });

    it("overwrites when --force is true", async () => {
      const first = await createAgent("dupe-agent");
      await new Promise((r) => setTimeout(r, 10));
      const second = await createAgent("dupe-agent", { force: true });
      expect(second.overwritten).toBe(true);
      expect(second.createdAt).not.toBe(first.createdAt);
    });
  });

  describe("listAgents", () => {
    it("returns empty array when no agents exist", async () => {
      expect(await listAgents()).toEqual([]);
    });

    it("lists created agents", async () => {
      await createAgent("alpha");
      await createAgent("beta");
      const names = (await listAgents()).map((a) => a.name).sort();
      expect(names).toEqual(["alpha", "beta"]);
    });

    it("does not list an agent whose directory is missing (orphaned registry entry)", async () => {
      await createAgent("ghost");
      // Simulate registry↔filesystem drift: registry entry without a directory.
      await rm(getAgentDir("ghost"), { recursive: true, force: true });
      expect(agentExists("ghost")).toBe(false);

      const names = (await listAgents()).map((a) => a.name);
      expect(names).not.toContain("ghost");
    });
  });

  describe("deleteAgent", () => {
    it("removes the agent dir and registry entry", async () => {
      await createAgent("gone");
      expect(agentExists("gone")).toBe(true);
      const deleted = await deleteAgent("gone");
      expect(deleted).toBe(true);
      expect(agentExists("gone")).toBe(false);

      const registry = JSON.parse(await readFile(getRegistryPath(), "utf8"));
      expect(registry.agents["gone"]).toBeUndefined();
    });

    it("returns false when agent does not exist", async () => {
      const deleted = await deleteAgent("nope");
      expect(deleted).toBe(false);
    });

    it("removes an orphaned registry entry when its directory is missing", async () => {
      await createAgent("ghost");
      // Simulate registry↔filesystem drift: registry entry without a directory.
      await rm(getAgentDir("ghost"), { recursive: true, force: true });
      expect(agentExists("ghost")).toBe(false);

      const deleted = await deleteAgent("ghost");
      expect(deleted).toBe(true);

      const registry = JSON.parse(await readFile(getRegistryPath(), "utf8"));
      expect(registry.agents["ghost"]).toBeUndefined();
    });

    it("scrubs the agent from every linked project's link-graph", async () => {
      await createAgent("linked-agent");
      const project = await mkdtemp(join(tmpdir(), "obagents-proj-"));
      await vaultGraph.link("linked-agent", ["generic"], project);

      const deleted = await deleteAgent("linked-agent");
      expect(deleted).toBe(true);

      const cfg = await getProjectConfig(project);
      expect(cfg.linkedAgents).not.toContain("linked-agent");
      expect(cfg.activeAgent).toBeUndefined();
      await rm(project, { recursive: true, force: true });
    });
  });
});