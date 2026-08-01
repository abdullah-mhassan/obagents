import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/memory/db.js";
import { addEpisode, findMemoryEpisodeByContent } from "../../src/memory/fts.js";
import { AgentMemoryVault } from "../../src/memory/vault.ts";
import { linkGraph } from "../../src/vault/link-graph.js";
import { projectVault } from "../../src/vault/project.js";
import { createGatewayMcpServer } from "../../src/mcp/server.js";
import { createAgent } from "../../src/vault/agent.js";
import { writeJsonAtomic, fs, useMemoryFileSystem, useNodeFileSystem } from "../../src/utils/fs.js";
import { resolveBinaryCommand } from "../../src/linker/mcp.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { compileAgent } from "../../src/vault/compiler.js";

describe("Critical Findings & Spec Remediations", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "obagents-crit-test-"));
    overrideVaultRoot(tmpRoot);
  });

  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe("4-tuple memory deduplication (agent, project, content, type)", () => {
    it("stores distinct entries for same summary but different type", () => {
      const db = openDatabase({ agentName: "agent-a", inMemory: true });
      addEpisode(db, {
        agentName: "agent-a",
        source: "memory",
        content: "Initialization complete",
        tags: "decision,/projects/app",
      });

      const ep1 = findMemoryEpisodeByContent(db, "agent-a", "Initialization complete", "/projects/app", "decision");
      expect(ep1).toBeDefined();

      const ep2 = findMemoryEpisodeByContent(db, "agent-a", "Initialization complete", "/projects/app", "milestone");
      expect(ep2).toBeUndefined();

      db.close();
    });

    it("excludes superseded rows from deduplication queries", () => {
      const db = openDatabase({ agentName: "agent-a", inMemory: true });
      const first = addEpisode(db, {
        agentName: "agent-a",
        source: "memory",
        content: "Fix bug #123",
        tags: "decision,/projects/app",
      });

      // Add a second episode that supersedes the first
      addEpisode(db, {
        agentName: "agent-a",
        source: "memory",
        content: "Fix bug #123 updated",
        tags: "decision,/projects/app",
        supersedes: first.id,
      });

      const foundOld = findMemoryEpisodeByContent(db, "agent-a", "Fix bug #123", "/projects/app", "decision");
      expect(foundOld).toBeUndefined();

      db.close();
    });
  });

  describe("setActiveAgentForProject link validation", () => {
    it("rejects setting active agent if agent is not linked to project", async () => {
      const projectDir = join(tmpRoot, "my-proj");
      await mkdir(projectDir, { recursive: true });

      await expect(
        linkGraph.setActiveAgentForProject(projectDir, "unlinked-agent")
      ).rejects.toThrow('Cannot set active agent to "unlinked-agent" because it is not linked');
    });
  });

  describe("createGatewayMcpServer projectDir validation", () => {
    it("rejects non-existent project directory", async () => {
      const phantomDir = join(tmpRoot, "does-not-exist");

      expect(() => createGatewayMcpServer(phantomDir)).toThrow(
        `Project directory "${phantomDir}" does not exist on disk.`
      );
    });
  });

  describe("Atomic JSON writes (writeJsonAtomic)", () => {
    it("atomically writes JSON to destination path", async () => {
      const targetFile = join(tmpRoot, "config.json");
      await writeJsonAtomic(targetFile, { foo: "bar" });

      const content = await fs.readFile(targetFile, "utf8");
      expect(JSON.parse(content)).toEqual({ foo: "bar" });
    });
  });

  describe("resolveBinaryCommand", () => {
    it("respects OBAGENTS_BIN environment variable override", () => {
      const oldEnv = process.env.OBAGENTS_BIN;
      try {
        process.env.OBAGENTS_BIN = "/custom/bin/obagents";
        expect(resolveBinaryCommand()).toBe("/custom/bin/obagents");
      } finally {
        process.env.OBAGENTS_BIN = oldEnv;
      }
    });
  });

  describe("compileAgent consolidation caching", () => {
    it("uses cached consolidation status on repeated compile calls", async () => {
      await createAgent("cached-agent");
      const projectDir = join(tmpRoot, "proj-cache");
      await mkdir(projectDir, { recursive: true });

      const compiled1 = await compileAgent("cached-agent", projectDir);
      expect(compiled1.needsConsolidation).toBe(false);

      const compiled2 = await compileAgent("cached-agent", projectDir);
      expect(compiled2.needsConsolidation).toBe(false);
    });
  });
});
