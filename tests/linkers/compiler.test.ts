import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createAgent } from "../../src/vault/agent.js";
import { compileAgent } from "../../src/vault/compiler.js";
import { openDatabase } from "../../src/memory/db.js";
import { addEpisode } from "../../src/memory/fts.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { buildBlock, hasBlock, injectBlock, removeBlock, buildStartMarker, buildEndMarker } from "../../src/linker/markers.js";
import { createMapper } from "../../src/linker/mappers/base.js";
import { DESCRIPTORS } from "../../src/linker/mappers/declarations.js";
import { SUPPORTED_TARGETS } from "../../src/utils/constants.js";

function getMapper(key: string) {
  const descriptor = DESCRIPTORS.find((d) => d.key === key);
  return descriptor ? createMapper(descriptor) : undefined;
}

function getMappers() {
  return DESCRIPTORS.map(createMapper);
}


let tmpRoot: string;
let projectDir: string;

async function fresh(projectName = "proj"): Promise<void> {
  tmpRoot = await mkdtemp(join(tmpdir(), "obagents-linker-"));
  overrideVaultRoot(tmpRoot);
  projectDir = join(tmpRoot, projectName);
  await mkdir(projectDir, { recursive: true });
}

async function readMayFail(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "<ENOENT>";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("markers", () => {
  it("buildBlock produces start/end markers with agent name and content", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    const block = buildBlock("hello", "alpha", iso);
    expect(block).toContain(buildStartMarker("alpha", iso));
    expect(block).toContain(buildEndMarker());
    expect(block).toContain("hello");
  });

  it("injectBlock replaces existing block idempotently", () => {
    const block1 = buildBlock("v1", "alpha");
    const block2 = buildBlock("v2", "alpha");
    const once = injectBlock("user rules\n", block1);
    const twice = injectBlock(once, block2);
    expect(hasBlock(twice)).toBe(true);
    expect(twice).toContain("user rules");
    expect(twice).toContain("v2");
    expect(twice).not.toContain("v1");
  });

  it("removeBlock strips the managed block and preserves user content", () => {
    const block = buildBlock("managed", "alpha");
    const content = injectBlock("user rules\n", block);
    const cleaned = removeBlock(content);
    expect(cleaned).toContain("user rules");
    expect(cleaned).not.toContain("managed");
    expect(cleaned).not.toContain("obagents:start");
  });

  it("removeBlock targets only a specific agent", () => {
    const a = buildBlock("agentA", "alpha");
    const b = buildBlock("agentB", "beta");
    const content = `${a}\n${b}`;
    const cleaned = removeBlock(content, "alpha");
    expect(cleaned).not.toContain("agentA");
    expect(cleaned).toContain("agentB");
  });
});

describe("compiler", () => {
  beforeEach(async () => {
    await fresh();
  });
  afterEach(async () => {
    overrideVaultRoot(null);
    await new Promise((r) => setTimeout(r, 20));
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("compiles the triad into a single markdown string and excludes default USER.md", async () => {
    await createAgent("comp");
    const brain = await compileAgent("comp");
    expect(brain.content).toContain("## SOUL");
    expect(brain.content).toContain("## MEMORY");
    expect(brain.content).not.toContain("## USER");
    expect(brain.content).toContain("## OB Agents Runtime Protocol");
    expect(brain.needsConsolidation).toBe(false);
  });

  it("flags needsConsolidation from the structured store once the row threshold is reached", async () => {
    await createAgent("big");
    const db = openDatabase({ agentName: "big" });
    for (let i = 0; i < 20; i++) {
      addEpisode(db, { agentName: "big", source: "memory", content: `distinct memory entry ${i}` });
    }
    db.close();
    const brain = await compileAgent("big");
    expect(brain.needsConsolidation).toBe(true);
  });

  it("throws on missing agent", async () => {
    await expect(compileAgent("ghost")).rejects.toThrow(/does not exist/);
  });
});

const MARKDOWN_MAPPERS: Array<{ key: string; owned: boolean; path: string }> = [
  { key: "cursor", owned: true, path: ".cursor/rules/obagents.mdc" },
  { key: "windsurf", owned: false, path: ".windsurfrules" },
  { key: "roo", owned: true, path: ".roo/rules/00-obagents.md" },
  { key: "continue", owned: true, path: ".continue/rules/00-obagents.md" },
  { key: "copilot", owned: false, path: ".github/copilot-instructions.md" },
  { key: "generic", owned: true, path: "AGENT.md" },
];

function createFakeContext(agentName: string, pDir: string, compiledContent: string): import("../../src/linker/types.js").LinkContext {
  return {
    agentName,
    projectDir: pDir,
    targets: [],
    async getRosterContent() {
      return compiledContent;
    },
    async getAgentMcpConfig() {
      return { command: "obagents", args: ["serve"] };
    }
  };
}

describe("markdown mappers (idempotency)", () => {
  beforeEach(async () => {
    await fresh();
    await createAgent("agent");
  });
  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  for (const { key, path } of MARKDOWN_MAPPERS) {
    it(`${key}: creates the file with a marker block on first link`, async () => {
      const adapter = getMapper(key)!;
      const context = createFakeContext("agent", projectDir, "compiled brain");
      const result = await adapter.apply(context);
      expect(result.action).toBe("created");
      const content = await readFile(join(projectDir, path), "utf8");
      expect(content).toContain("obagents:start");
      expect(content).toContain("obagents:end");
      expect(content).toContain("compiled brain");
    });

    it(`${key}: re-link replaces block idempotently without duplication`, async () => {
      const adapter = getMapper(key)!;
      let context = createFakeContext("agent", projectDir, "first version");
      await adapter.apply(context);
      context = createFakeContext("agent", projectDir, "second version");
      const result = await adapter.apply(context);
      expect(result.action).toBe("updated");
      const content = await readFile(join(projectDir, path), "utf8");
      expect(content).toContain("second version");
      expect(content).not.toContain("first version");
      const startCount = (content.match(/obagents:start/g) || []).length;
      expect(startCount).toBe(1);
    });

    it(`${key}: appends block into existing user file without destroying it`, async () => {
      const adapter = getMapper(key)!;
      const filePath = join(projectDir, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, "user rules\n", "utf8");
      const context = createFakeContext("agent", projectDir, "managed");
      const result = await adapter.apply(context);
      expect(result.action).toBe("modified");
      const content = await readFile(filePath, "utf8");
      expect(content).toContain("user rules");
      expect(content).toContain("managed");
    });

    it(`${key}: clean removes the standalone owned file`, async () => {
      const adapter = getMapper(key)!;
      const context = createFakeContext("agent", projectDir, "managed");
      await adapter.apply(context);
      await adapter.remove(context, { agentName: "agent" });
      const remaining = await readMayFail(join(projectDir, path));
      expect(remaining).toBe("<ENOENT>");
    });
  }

  it("windsurf/copilot: clean preserves user content after removing block", async () => {
    const adapter = getMapper("windsurf")!;
    const path = ".windsurfrules";
    await writeFile(join(projectDir, path), "user rules\n", "utf8");
    const context = createFakeContext("agent", projectDir, "managed");
    await adapter.apply(context);
    await adapter.remove(context, { agentName: "agent" });
    const remaining = await readFile(join(projectDir, path), "utf8");
    expect(remaining).toContain("user rules");
    expect(remaining).not.toContain("managed");
  });
});

describe("claude-code mapper", () => {
  let settingsPath: string;

  beforeEach(async () => {
    await fresh("claude-proj");
    await createAgent("agent");
    const settingsDir = join(tmpRoot, "claude-settings");
    await mkdir(settingsDir, { recursive: true });
    settingsPath = join(settingsDir, "settings.json");
    const { overrideClaudeSettingsPath } = await import("../../src/utils/paths.js");
    overrideClaudeSettingsPath(settingsPath);
  });
  afterEach(async () => {
    overrideVaultRoot(null);
    const { overrideClaudeSettingsPath } = await import("../../src/utils/paths.js");
    overrideClaudeSettingsPath(null);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes CLAUDE.md with markers and registers path in settings.json", async () => {
    const adapter = getMapper("claude-code")!;
    const context = createFakeContext("agent", projectDir, "brain");
    await adapter.apply(context);
    const content = await readFile(join(projectDir, "CLAUDE.md"), "utf8");
    expect(content).toContain("obagents:start");
    expect(content).toContain("brain");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.contextPaths).toContain(join(projectDir, "CLAUDE.md"));
  });

  it("clean removes the path from settings.json", async () => {
    const adapter = getMapper("claude-code")!;
    const context = createFakeContext("agent", projectDir, "brain");
    await adapter.apply(context);
    await adapter.remove(context, { agentName: "agent" });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.contextPaths).not.toContain(join(projectDir, "CLAUDE.md"));
  });
});

describe("command-code mapper", () => {
  beforeEach(async () => {
    await fresh("command-code-proj");
    await createAgent("agent");
  });
  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes AGENTS.md with markers and registers the MCP server in .mcp.json", async () => {
    const adapter = getMapper("command-code")!;
    const context = createFakeContext("agent", projectDir, "brain");
    const result = await adapter.apply(context);
    expect(result.action).toBe("created");
    const content = await readFile(join(projectDir, "AGENTS.md"), "utf8");
    expect(content).toContain("obagents:start");
    expect(content).toContain("obagents:end");
    expect(content).toContain("brain");
    const mcp = JSON.parse(await readFile(join(projectDir, ".mcp.json"), "utf8"));
    const serverKey = Object.keys(mcp.mcpServers)[0];
    expect(serverKey).toBe("obagents");
    expect(mcp.mcpServers[serverKey]).toEqual({ command: "obagents", args: ["serve"] });
  });

  it("re-link is idempotent: one block and one MCP entry", async () => {
    const adapter = getMapper("command-code")!;
    let context = createFakeContext("agent", projectDir, "first version");
    await adapter.apply(context);
    context = createFakeContext("agent", projectDir, "second version");
    await adapter.apply(context);
    const content = await readFile(join(projectDir, "AGENTS.md"), "utf8");
    expect(content).toContain("second version");
    expect(content).not.toContain("first version");
    const startCount = (content.match(/obagents:start/g) || []).length;
    expect(startCount).toBe(1);
    const mcp = JSON.parse(await readFile(join(projectDir, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toHaveLength(1);
  });

  it("clean removes the agent's block and MCP entry while preserving user content", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    await writeFile(filePath, "user rules\n", "utf8");
    const adapter = getMapper("command-code")!;
    const context = createFakeContext("agent", projectDir, "managed");
    await adapter.apply(context);
    await adapter.remove(context, { agentName: "agent" });
    const remaining = await readFile(filePath, "utf8");
    expect(remaining).toContain("user rules");
    expect(remaining).not.toContain("managed");
    const mcp = JSON.parse(await readFile(join(projectDir, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers || {})).toHaveLength(0);
  });
});

describe("aider mapper", () => {
  beforeEach(async () => {
    await fresh("aider-proj");
    await createAgent("agent");
  });
  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes vault triad paths into the read: array of .aider.conf.yml", async () => {
    const adapter = getMapper("aider")!;
    const context = createFakeContext("agent", projectDir, "ignored");
    await adapter.apply(context);
    const raw = await readFile(join(projectDir, ".aider.conf.yml"), "utf8");
    expect(raw).toContain("read:");
    expect(raw).toContain("SOUL.md");
    expect(raw).toContain("MEMORY.md");
    expect(raw).toContain("USER.md");
  });

  it("idempotently re-links without duplicating read entries", async () => {
    const adapter = getMapper("aider")!;
    const context = createFakeContext("agent", projectDir, "ignored");
    await adapter.apply(context);
    await adapter.apply(context);
    const raw = await readFile(join(projectDir, ".aider.conf.yml"), "utf8");
    const soulMatches = raw.match(/SOUL\.md/g) || [];
    expect(soulMatches.length).toBe(1);
  });

  it("clean removes the agent's triad paths", async () => {
    const adapter = getMapper("aider")!;
    const context = createFakeContext("agent", projectDir, "ignored");
    await adapter.apply(context);
    await adapter.remove(context, { agentName: "agent" });
    expect(await exists(join(projectDir, ".aider.conf.yml"))).toBe(false);
  });

  it("preserves existing user read entries on clean", async () => {
    const adapter = getMapper("aider")!;
    const context = createFakeContext("agent", projectDir, "ignored");
    await writeFile(join(projectDir, ".aider.conf.yml"), "read: [OTHER.md]\n", "utf8");
    await adapter.apply(context);
    await adapter.remove(context, { agentName: "agent" });
    const raw = await readFile(join(projectDir, ".aider.conf.yml"), "utf8");
    expect(raw).toContain("OTHER.md");
  });
});

describe("registry of mappers", () => {
  it("exposes all supported targets", () => {
    const keys = getMappers().map((m) => m.key);
    for (const target of SUPPORTED_TARGETS) {
      expect(keys).toContain(target);
      expect(getMapper(target)).toBeDefined();
    }
  });

  it("returns undefined for unknown target", () => {
    expect(getMapper("nope")).toBeUndefined();
  });
});