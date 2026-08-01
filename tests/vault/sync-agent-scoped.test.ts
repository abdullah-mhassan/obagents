import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { useMemoryFileSystem, useNodeFileSystem, MemoryFileSystem } from "../../src/utils/fs.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { createAgent } from "../../src/vault/agent.js";
import { vaultSyncEngine } from "../../src/vault/sync.js";
import {
  extractBlockContent,
  hasBlock,
  hasLegacyBlock,
  buildBlock,
} from "../../src/linker/markers.js";

const linkAgent = vaultSyncEngine.linkAgent.bind(vaultSyncEngine);
const unlinkAgent = vaultSyncEngine.unlinkAgent.bind(vaultSyncEngine);

const PROJECT = "/virtual/project";
const VAULT = "/virtual/vault";
const AGENT_MD = join(PROJECT, "AGENT.md");

const LEGACY_HIVE_BLOCK =
  '<!-- obagents:start agent="hive" generated="2026-01-01T00:00:00.000Z" -->\n' +
  "legacy hive content\n" +
  "<!-- obagents:end -->";

describe("VaultSync: agent-scoped blocks in a passive target", () => {
  let memFS: MemoryFileSystem;

  beforeEach(async () => {
    memFS = useMemoryFileSystem();
    overrideVaultRoot(VAULT);
    await createAgent("alpha");
    await createAgent("beta");
    await memFS.mkdir(PROJECT);
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
  });

  it("keeps both agents' blocks when a second agent is linked to one passive target", async () => {
    await linkAgent("alpha", { targets: ["generic"], projectDir: PROJECT });
    await linkAgent("beta", { targets: ["generic"], projectDir: PROJECT });

    const content = await memFS.readFile(AGENT_MD);
    expect((content.match(/obagents:start/g) || []).length).toBe(2);
    expect(hasBlock(content, "alpha")).toBe(true);
    expect(hasBlock(content, "beta")).toBe(true);
    expect(extractBlockContent(content, "alpha")).toContain("# alpha");
    expect(extractBlockContent(content, "beta")).toContain("# beta");
  });

  it("unlinking one agent leaves the other's block intact", async () => {
    await linkAgent("alpha", { targets: ["generic"], projectDir: PROJECT });
    await linkAgent("beta", { targets: ["generic"], projectDir: PROJECT });

    await unlinkAgent("alpha", { targets: ["generic"], projectDir: PROJECT });

    const content = await memFS.readFile(AGENT_MD);
    expect(hasBlock(content, "beta")).toBe(true);
    expect(hasBlock(content, "alpha")).toBe(false);
    const betaBlock = extractBlockContent(content, "beta");
    expect(betaBlock).toContain("# beta");
    expect(betaBlock).not.toContain("# alpha");
  });

  it("re-linking an agent after unlink replaces only that agent's block", async () => {
    await linkAgent("alpha", { targets: ["generic"], projectDir: PROJECT });
    await linkAgent("beta", { targets: ["generic"], projectDir: PROJECT });
    await unlinkAgent("alpha", { targets: ["generic"], projectDir: PROJECT });

    await linkAgent("alpha", { targets: ["generic"], projectDir: PROJECT });

    const content = await memFS.readFile(AGENT_MD);
    expect((content.match(/obagents:start/g) || []).length).toBe(2);
    expect(hasBlock(content, "alpha")).toBe(true);
    expect(hasBlock(content, "beta")).toBe(true);
    expect(extractBlockContent(content, "beta")).toContain("# beta");
  });

  it("migrates a legacy agent=\"hive\" block to the linking agent and removes it on unlink", async () => {
    await memFS.writeFile(AGENT_MD, `${LEGACY_HIVE_BLOCK}\n`, "utf8");

    await linkAgent("alpha", { targets: ["generic"], projectDir: PROJECT });

    const migrated = await memFS.readFile(AGENT_MD);
    expect(hasLegacyBlock(migrated)).toBe(false);
    expect(hasBlock(migrated, "alpha")).toBe(true);
    expect(extractBlockContent(migrated, "alpha")).toContain("# alpha");

    await unlinkAgent("alpha", { targets: ["generic"], projectDir: PROJECT });
    expect(memFS.existsSync(AGENT_MD)).toBe(false);
  });

  it("leaves a legacy block untouched when another agent's block coexists and that agent is unlinked", async () => {
    const betaBlock = buildBlock("beta owned content", "beta");
    await memFS.writeFile(AGENT_MD, `${LEGACY_HIVE_BLOCK}\n\n${betaBlock}\n`, "utf8");

    await unlinkAgent("beta", { targets: ["generic"], projectDir: PROJECT });

    const content = await memFS.readFile(AGENT_MD);
    expect(hasLegacyBlock(content)).toBe(true);
    expect(hasBlock(content, "beta")).toBe(false);
    expect(content).toContain("legacy hive content");
  });

  it("deletes an owned file only when the last agent unlinks and no other block remains", async () => {
    await linkAgent("alpha", { targets: ["generic"], projectDir: PROJECT });
    await linkAgent("beta", { targets: ["generic"], projectDir: PROJECT });

    await unlinkAgent("alpha", { targets: ["generic"], projectDir: PROJECT });
    expect(memFS.existsSync(AGENT_MD)).toBe(true);
    expect(hasBlock(await memFS.readFile(AGENT_MD), "beta")).toBe(true);

    await unlinkAgent("beta", { targets: ["generic"], projectDir: PROJECT });
    expect(memFS.existsSync(AGENT_MD)).toBe(false);
  });
});
