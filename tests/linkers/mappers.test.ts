import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useMemoryFileSystem, useNodeFileSystem, MemoryFileSystem } from "../../src/utils/fs.js";
import { createMapper } from "../../src/linker/mappers/base.js";
import { DESCRIPTORS } from "../../src/linker/mappers/declarations.js";
import {
  buildBlock,
  hasBlock,
  injectBlock,
  removeBlock,
} from "../../src/linker/markers.js";
import type { LinkContext } from "../../src/linker/types.js";

const genericMapper = createMapper(DESCRIPTORS.find((d) => d.key === "generic")!);
const cursorMapper = createMapper(DESCRIPTORS.find((d) => d.key === "cursor")!);


const PROJECT = "/virtual/project";

function createFakeContext(agentName: string, projectDir: string, compiledContent: string): LinkContext {
  return {
    agentName,
    projectDir,
    targets: ["generic"],
    async getRosterContent() {
      return compiledContent;
    },
    async getPassiveContent() {
      return `${compiledContent}\n\n## SOUL\n\nPersona details`;
    },
    async getAgentMcpConfig() {
      return { command: "obagents", args: ["serve", agentName] };
    }
  };
}

describe("linker markers", () => {
  it("builds a delimited block", () => {
    const block = buildBlock("hello", "agent");
    expect(block).toContain('obagents:start agent="agent"');
    expect(block).toContain("hello");
    expect(block).toContain("obagents:end");
  });

  it("detects and removes a block", () => {
    const block = buildBlock("body", "agent");
    const file = `# Title\n\n${block}\n`;
    expect(hasBlock(file)).toBe(true);
    const remaining = removeBlock(file);
    expect(hasBlock(remaining)).toBe(false);
    expect(remaining).toContain("# Title");
    expect(remaining).not.toContain("body");
  });

  it("injects into existing content without duplicating", () => {
    const block = buildBlock("v2", "agent");
    const existing = buildBlock("v1", "agent");
    const updated = injectBlock(existing, block, "agent");
    expect(updated.match(/obagents:start/g)?.length).toBe(1);
    expect(updated).toContain("v2");
    expect(updated).not.toContain("v1");
  });
});

describe("createMarkdownMapper (generic / AGENT.md)", () => {
  let memFS: MemoryFileSystem;

  beforeEach(() => {
    memFS = useMemoryFileSystem();
  });

  afterEach(() => {
    useNodeFileSystem();
  });

  it("creates the file with the block when none exists", async () => {
    const context = createFakeContext("agent", PROJECT, "brain");
    const result = await genericMapper.apply(context);
    expect(result.action).toBe("created");
    expect(memFS.existsSync(`${PROJECT}/AGENT.md`)).toBe(true);
    const content = await memFS.readFile(`${PROJECT}/AGENT.md`);
    expect(content).toContain('agent="agent"');
    expect(content.endsWith("\n")).toBe(true);
  });

  it("reports updated when a block already exists", async () => {
    let context = createFakeContext("agent", PROJECT, "first");
    await genericMapper.apply(context);
    context = createFakeContext("agent", PROJECT, "second");
    const result = await genericMapper.apply(context);
    expect(result.action).toBe("updated");
    const content = await memFS.readFile(`${PROJECT}/AGENT.md`);
    expect(content).toContain("second");
    expect(content).not.toContain("first");
  });

  it("reports modified when appending a new agent block to existing content", async () => {
    await memFS.writeFile(`${PROJECT}/AGENT.md`, "# Project notes\n");
    const context = createFakeContext("agent", PROJECT, "brain");
    const result = await genericMapper.apply(context);
    expect(result.action).toBe("modified");
    const content = await memFS.readFile(`${PROJECT}/AGENT.md`);
    expect(content).toContain("# Project notes");
    expect(content).toContain('agent="agent"');
  });

  it("does not write on dry-run but reports the would-be action", async () => {
    await memFS.writeFile(`${PROJECT}/AGENT.md`, "# Existing\n");
    const context = createFakeContext("agent", PROJECT, "brain");
    const result = await genericMapper.apply(context, { dryRun: true });
    expect(result.action).toBe("modified");
    const content = await memFS.readFile(`${PROJECT}/AGENT.md`);
    expect(content).toBe("# Existing\n");
  });

  it("removes the whole owned file when only the block remains", async () => {
    const context = createFakeContext("agent", PROJECT, "brain");
    await genericMapper.apply(context);
    await genericMapper.remove(context, { agentName: "agent" });
    expect(memFS.existsSync(`${PROJECT}/AGENT.md`)).toBe(false);
  });

  it("preserves non-owned user content after clean", async () => {
    await memFS.writeFile(`${PROJECT}/AGENT.md`, "# User notes\n\n" + buildBlock("brain", "agent") + "\n");
    const context = createFakeContext("agent", PROJECT, "brain");
    await genericMapper.remove(context, { agentName: "agent" });
    expect(memFS.existsSync(`${PROJECT}/AGENT.md`)).toBe(true);
    const content = await memFS.readFile(`${PROJECT}/AGENT.md`);
    expect(content).toContain("# User notes");
    expect(content).not.toContain("brain");
    expect(content).not.toContain('agent="hive"');
  });

  it("skips writing on dry-run clean", async () => {
    const context = createFakeContext("agent", PROJECT, "brain");
    await genericMapper.apply(context);
    await genericMapper.remove(context, { agentName: "agent", dryRun: true });
    expect(memFS.existsSync(`${PROJECT}/AGENT.md`)).toBe(true);
  });

  it("uses passive content mode (SOUL + MEMORY + USER) for generic target", async () => {
    const context = createFakeContext("agent", PROJECT, "roster");
    await genericMapper.apply(context);
    const content = await memFS.readFile(`${PROJECT}/AGENT.md`);
    expect(content).toContain("Persona details");
  });
});

describe("createMarkdownMapper with frontmatter (cursor)", () => {
  let memFS: MemoryFileSystem;

  beforeEach(() => {
    memFS = useMemoryFileSystem();
  });

  afterEach(() => {
    useNodeFileSystem();
  });

  it("preserves frontmatter prefix across updates", async () => {
    let context = createFakeContext("agent", PROJECT, "v1");
    await cursorMapper.apply(context);
    context = createFakeContext("agent", PROJECT, "v2");
    await cursorMapper.apply(context);
    const content = await memFS.readFile(`${PROJECT}/.cursor/rules/obagents.mdc`);
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("v2");
    expect(content).not.toContain("v1");
    const frontmatterCount = content.split("---").length - 1;
    expect(frontmatterCount).toBe(2);
  });

  it("links the MCP server config alongside the markdown", async () => {
    const context = createFakeContext("agent", PROJECT, "brain");
    await cursorMapper.apply(context);
    expect(memFS.existsSync(`${PROJECT}/.cursor/mcp.json`)).toBe(true);
    const mcp = JSON.parse(await memFS.readFile(`${PROJECT}/.cursor/mcp.json`));
    const serverKey = Object.keys(mcp.mcpServers)[0];
    expect(serverKey).toMatch(/^obagents-agent-/);
  });

  it("removes the MCP server config on clean", async () => {
    const context = createFakeContext("agent", PROJECT, "brain");
    await cursorMapper.apply(context);
    await cursorMapper.remove(context, { agentName: "agent" });
    const mcp = JSON.parse(await memFS.readFile(`${PROJECT}/.cursor/mcp.json`));
    expect(Object.keys(mcp.mcpServers || {}).some((k) => k.startsWith("obagents-agent-"))).toBe(false);
  });
});
