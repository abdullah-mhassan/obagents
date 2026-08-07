import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { useMemoryFileSystem, useNodeFileSystem, fs } from "../../src/utils/fs.js";
import { overrideVaultRoot, getRegistryPath, getAgentMetaPath } from "../../src/utils/paths.js";
import { readRegistry } from "../../src/vault/registry.js";
import { getProjectConfig } from "../../src/vault/project.js";
import { getAgentMeta } from "../../src/vault/metadata.js";
import { createAgent } from "../../src/vault/agent.js";
import { vaultGraph } from "../../src/vault/link-graph.js";

const VAULT = "/virtual/vault";
const PROJ_A = "/virtual/project-a";

describe("Persistence write-safety: corruption-safe reads", () => {
  beforeEach(async () => {
    useMemoryFileSystem();
    overrideVaultRoot(VAULT);
    await fs.mkdir(PROJ_A, { recursive: true });
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
  });

  it("readRegistry throws a domain error naming the file when agents.json is unparseable", async () => {
    const registryPath = getRegistryPath();
    await fs.writeFile(registryPath, "{ not json !!!", "utf8");

    await expect(readRegistry()).rejects.toThrow(/Corrupt registry at .*agents\.json/);

    const onDisk = await fs.readFile(registryPath, "utf8");
    expect(onDisk).toBe("{ not json !!!");
  });

  it("readRegistry throws when agents.json parses but lacks the agents field", async () => {
    const registryPath = getRegistryPath();
    await fs.writeFile(registryPath, JSON.stringify({ version: 1 }), "utf8");

    await expect(readRegistry()).rejects.toThrow(/Corrupt registry at .*agents\.json/);
  });

  it("a write operation surfaces the corruption error and leaves the file untouched", async () => {
    const registryPath = getRegistryPath();
    await fs.writeFile(registryPath, "{ not json !!!", "utf8");

    await expect(createAgent("victim")).rejects.toThrow(/Corrupt registry at .*agents\.json/);

    const onDisk = await fs.readFile(registryPath, "utf8");
    expect(onDisk).toBe("{ not json !!!");
  });

  it("a missing registry still yields the empty default", async () => {
    const registry = await readRegistry();
    expect(registry.agents).toEqual({});
  });

  it("getProjectConfig throws a domain error naming the file when the project config is unparseable", async () => {
    const configPath = join(PROJ_A, ".obagents-project.json");
    await fs.writeFile(configPath, "{ nope", "utf8");

    await expect(getProjectConfig(PROJ_A)).rejects.toThrow(
      /Corrupt project config at .*\.obagents-project\.json/,
    );

    const onDisk = await fs.readFile(configPath, "utf8");
    expect(onDisk).toBe("{ nope");
  });

  it("link operations surface a corrupted project config instead of silently dropping roster entries", async () => {
    await createAgent("roster-agent");
    const configPath = join(PROJ_A, ".obagents-project.json");
    await fs.writeFile(configPath, "{ nope", "utf8");

    await expect(vaultGraph.link("roster-agent", ["generic"], PROJ_A)).rejects.toThrow(
      /Corrupt project config at/,
    );

    const onDisk = await fs.readFile(configPath, "utf8");
    expect(onDisk).toBe("{ nope");
  });

  it("getAgentMeta throws a domain error naming the file when agent metadata is unparseable", async () => {
    await createAgent("meta-agent");
    const metaPath = getAgentMetaPath("meta-agent");
    await fs.writeFile(metaPath, "not-json", "utf8");

    await expect(getAgentMeta("meta-agent")).rejects.toThrow(/Corrupt agent metadata at .*agent\.json/);

    const onDisk = await fs.readFile(metaPath, "utf8");
    expect(onDisk).toBe("not-json");
  });
});

describe("Persistence write-safety: serialized read-modify-write", () => {
  beforeEach(async () => {
    useMemoryFileSystem();
    overrideVaultRoot(VAULT);
    await fs.mkdir(PROJ_A, { recursive: true });
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
  });

  it("concurrent createAgent calls all land in the registry", async () => {
    await Promise.all([
      createAgent("conc-a"),
      createAgent("conc-b"),
      createAgent("conc-c"),
      createAgent("conc-d"),
    ]);

    const registry = await readRegistry();
    expect(Object.keys(registry.agents).sort()).toEqual(["conc-a", "conc-b", "conc-c", "conc-d"]);
  });

  it("concurrent link calls never lose project roster entries", async () => {
    await Promise.all([
      createAgent("link-a"),
      createAgent("link-b"),
      createAgent("link-c"),
      createAgent("link-d"),
    ]);

    await Promise.all([
      vaultGraph.link("link-a", ["generic"], PROJ_A),
      vaultGraph.link("link-b", ["generic"], PROJ_A),
      vaultGraph.link("link-c", ["generic"], PROJ_A),
      vaultGraph.link("link-d", ["generic"], PROJ_A),
    ]);

    const config = await getProjectConfig(PROJ_A);
    expect([...config.linkedAgents].sort()).toEqual(["link-a", "link-b", "link-c", "link-d"]);
  });

  it("concurrent link calls to the same agent never lose per-project links", async () => {
    await createAgent("multi-link");
    const PROJ_B = "/virtual/project-b";
    await fs.mkdir(PROJ_B, { recursive: true });

    await Promise.all([
      vaultGraph.link("multi-link", ["generic"], PROJ_A),
      vaultGraph.link("multi-link", ["cursor"], PROJ_B),
    ]);

    const projects = await vaultGraph.getProjectsForAgent("multi-link");
    expect(projects.sort()).toEqual([PROJ_A, PROJ_B]);
  });
});
