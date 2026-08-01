import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useMemoryFileSystem, useNodeFileSystem, MemoryFileSystem } from "../../src/utils/fs.js";
import { createMapper } from "../../src/linker/mappers/base.js";
import { aiderDescriptor } from "../../src/linker/mappers/aider.js";
import { getCoreFilePath } from "../../src/vault/project.js";
import { parse, stringify } from "yaml";
import type { LinkContext } from "../../src/linker/types.js";

const PROJECT = "/virtual/project";

function createFakeContext(agentName: string, projectDir: string, compiledContent: string): LinkContext {
  return {
    agentName,
    projectDir,
    targets: [],
    async getRosterContent() {
      return compiledContent;
    },
    async getPassiveContent() {
      return compiledContent;
    },
    async getAgentMcpConfig() {
      return { command: "obagents", args: ["serve"] };
    }
  };
}

describe("aider mapper", () => {
  let memFS: MemoryFileSystem;

  beforeEach(() => {
    memFS = useMemoryFileSystem();
  });

  afterEach(() => {
    useNodeFileSystem();
  });

  it("is correctly loaded by the factory/registry", () => {
    const aiderMapper = createMapper(aiderDescriptor);
    expect(aiderMapper).toBeDefined();
    expect(aiderMapper?.name).toBe("Aider");
    expect(aiderMapper?.key).toBe("aider");
  });


  it("links to the project-scoped memory in the vault and ensures project MEMORY.md exists", async () => {
    const aiderMapper = createMapper(aiderDescriptor);
    const context = createFakeContext("myagent", PROJECT, "compiled-content");
    await aiderMapper.apply(context);
    const configPath = `${PROJECT}/.aider.conf.yml`;
    expect(memFS.existsSync(configPath)).toBe(true);
    
    const content = await memFS.readFile(configPath);
    const parsed = parse(content);
    
    const scopedMemoryPath = getCoreFilePath("myagent", "MEMORY.md", PROJECT);
    expect(parsed.read).toContain(scopedMemoryPath);
    expect(memFS.existsSync(scopedMemoryPath)).toBe(true);
  });

  it("detects the configuration file if it exists", async () => {
    const aiderMapper = createMapper(aiderDescriptor);
    expect(aiderMapper.detect(PROJECT)).toBe(false);

    await memFS.writeFile(`${PROJECT}/.aider.conf.yml`, stringify({ read: [] }));
    expect(aiderMapper.detect(PROJECT)).toBe(true);
  });

  it("cleans project-scoped memory paths from read array", async () => {
    const aiderMapper = createMapper(aiderDescriptor);
    const configPath = `${PROJECT}/.aider.conf.yml`;
    const context = createFakeContext("myagent", PROJECT, "compiled-content");
    
    // Write then clean
    await aiderMapper.apply(context);
    expect(memFS.existsSync(configPath)).toBe(true);

    await aiderMapper.remove(context, { agentName: "myagent" });
    expect(memFS.existsSync(configPath)).toBe(false); // deletes file if empty
  });
});
