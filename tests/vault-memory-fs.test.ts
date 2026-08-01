import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useMemoryFileSystem, useNodeFileSystem } from "../src/utils/fs.js";
import {
  writeCoreTo,
  ensureCoreDirectives,
  coreDirectivesVersionIn,
  buildCoreDirectivesBlock,
  CORE_DIRECTIVES_VERSION,
  CORE_FILES,
} from "../src/vault/triad.js";
import { compileAgent } from "../src/vault/compiler.js";
import { overrideVaultRoot, TEMPLATES_DIR } from "../src/utils/paths.js";
import { join } from "node:path";

describe("Vault Operations (In-Memory FileSystem)", () => {
  let memFS: any;
  const mockVaultRoot = "/virtual/vault";

  beforeEach(() => {
    memFS = useMemoryFileSystem();
    overrideVaultRoot(mockVaultRoot);
  });

  afterEach(() => {
    useNodeFileSystem();
    overrideVaultRoot(null);
  });

  it("writes triad files to memory filesystem", async () => {
    const targetDir = "/virtual/vault/agents/in-mem-agent";
    await writeCoreTo(targetDir, "in-mem-agent", "VFS Test Agent");

    expect(memFS.existsSync(join(targetDir, "SOUL.md"))).toBe(true);
    expect(memFS.existsSync(join(targetDir, "MEMORY.md"))).toBe(true);
    expect(memFS.existsSync(join(targetDir, "USER.md"))).toBe(true);

    const soulContent = await memFS.readFile(join(targetDir, "SOUL.md"));
    expect(soulContent).toContain("in-mem-agent");
    expect(soulContent).toContain("VFS Test Agent");
  });

  it("writeCoreTo with a bundled archetype name writes all three files with placeholders substituted", async () => {
    const { readFile: readRealFile } = await import("node:fs/promises");
    const archetypeDir = join(TEMPLATES_DIR, "archetypes", "engineer");
    for (const file of CORE_FILES) {
      await memFS.writeFile(
        join(archetypeDir, file),
        await readRealFile(join(archetypeDir, file), "utf8"),
      );
    }

    const targetDir = "/virtual/vault/agents/arch-agent";
    await writeCoreTo(targetDir, "arch-agent", "Senior Architect", "engineer");

    for (const file of CORE_FILES) {
      expect(memFS.existsSync(join(targetDir, file))).toBe(true);
    }

    const soul = await memFS.readFile(join(targetDir, "SOUL.md"));
    expect(soul).toContain("# arch-agent");
    expect(soul).toContain("Senior Architect");
    expect(soul).toContain("## Responsibilities");
    expect(soul).toContain("<!-- obagents:core-directives v1 -->");

    const memory = await memFS.readFile(join(targetDir, "MEMORY.md"));
    expect(memory).toContain("# Working Memory");
    expect(memory).toContain("## Current objective");

    const user = await memFS.readFile(join(targetDir, "USER.md"));
    expect(user).toContain("# User Context");
    expect(user).toContain("## Preferences");
  });

  it("compiles agent triad files correctly in-memory", async () => {
    const targetDir = "/virtual/vault/agents/compiler-agent";
    await writeCoreTo(targetDir, "compiler-agent", "Compiler VFS Test");

    const compiled = await compileAgent("compiler-agent");
    expect(compiled.content).toContain("## SOUL");
    expect(compiled.content).toContain("Compiler VFS Test");
    expect(compiled.content).toContain("## MEMORY");
    // USER.md with defaults should not be injected
    expect(compiled.content).not.toContain("## USER");
  });

  it("compiles agent with project-scoped MEMORY.md when projectDir is provided", async () => {
    const targetDir = "/virtual/vault/agents/scoped-compiler-agent";
    await writeCoreTo(targetDir, "scoped-compiler-agent", "Scoped Test");
    const projectDir = "/virtual/project-x";

    const { projectVault } = await import("../src/vault/project.js");
    await projectVault.ensureProjectMemoryExists("scoped-compiler-agent", projectDir);
    const scopedMemPath = projectVault.getCoreFilePath("scoped-compiler-agent", "MEMORY.md", projectDir);
    await memFS.writeFile(scopedMemPath, "# Scoped Project X Working Memory");

    const compiled = await compileAgent("scoped-compiler-agent", projectDir);
    expect(compiled.content).toContain("# Scoped Project X Working Memory");
  });

  it("compileAgent never materializes project memory files (read-only contract)", async () => {
    const targetDir = "/virtual/vault/agents/ro-compiler-agent";
    await writeCoreTo(targetDir, "ro-compiler-agent", "Read-Only Test");
    const projectDir = "/virtual/project-ro";

    const compiled = await compileAgent("ro-compiler-agent", projectDir);
    expect(compiled.content).toContain("## SOUL");
    expect(compiled.content).toContain("Read-Only Test");
    expect(memFS.existsSync(join(targetDir, "projects"))).toBe(false);
  });

  it("bakes the OB Agents Runtime Protocol section into every compiled brain", async () => {
    const targetDir = "/virtual/vault/agents/disc-agent";
    await writeCoreTo(targetDir, "disc-agent", "Discipline Test");

    const compiled = await compileAgent("disc-agent");
    expect(compiled.content).toContain("## OB Agents Runtime Protocol");
    expect(compiled.content).toContain("Record only durable outcomes with `update_state`:");
    expect(compiled.content).toContain("a verified build or test recovery;");
    expect(compiled.content).toContain("a completed, testable milestone.");
    expect(compiled.content).toContain("When the working-memory summary is stale, consolidate it instead of appending noise.");
  });

  it("frames the default MEMORY.md with single source of truth template", async () => {
    const targetDir = "/virtual/vault/agents/mem-agent";
    await writeCoreTo(targetDir, "mem-agent", "Memory Framing Test");

    const memoryContent = await memFS.readFile(join(targetDir, "MEMORY.md"));
    expect(memoryContent).toContain("# Working Memory");
    expect(memoryContent).toContain("A concise summary of the current project context");
    expect(memoryContent).toContain("## Current objective");
    expect(memoryContent).toContain("- No active objective recorded.");
  });

  it("includes Operating principles in default SOUL", async () => {
    const targetDir = "/virtual/vault/agents/soul-agent";
    await writeCoreTo(targetDir, "soul-agent", "Soul Test");

    const soulContent = await memFS.readFile(join(targetDir, "SOUL.md"));
    expect(soulContent).toContain("## Operating principles");
    expect(soulContent).toContain("Focus on the user’s outcome and make progress with the information available.");
  });

  it("creates default SOUL with operating principles", async () => {
    const targetDir = "/virtual/vault/agents/marker-agent";
    await writeCoreTo(targetDir, "marker-agent", "Marker Test");

    const soulContent = await memFS.readFile(join(targetDir, "SOUL.md"));
    expect(soulContent).toContain("# marker-agent");
    expect(soulContent).toContain("## Role");
    expect(soulContent).toContain("Marker Test");
    expect(soulContent).toContain("## Operating principles");
  });
});

describe("ensureCoreDirectives (versioned marker)", () => {
  it("appends the block when no marker is present", () => {
    const result = ensureCoreDirectives("# Persona\nCustom soul.");
    expect(result).toContain("# Persona");
    expect(coreDirectivesVersionIn(result)).toBe(CORE_DIRECTIVES_VERSION);
  });

  it("is idempotent when the current version is already present", () => {
    const once = ensureCoreDirectives("# Persona");
    const twice = ensureCoreDirectives(once);
    expect(twice).toBe(once);
    expect((twice.match(/obagents:core-directives/g) ?? []).length).toBe(2); // start + end marker, single block
  });

  it("replaces a stale older-version block instead of duplicating it", () => {
    const stale =
      "# Persona\n\n<!-- obagents:core-directives v0 -->\nOLD WORDING\n<!-- obagents:core-directives:end -->\n";
    const result = ensureCoreDirectives(stale);
    expect(result).not.toContain("OLD WORDING");
    expect(coreDirectivesVersionIn(result)).toBe(CORE_DIRECTIVES_VERSION);
    // Exactly one block: start marker appears once.
    expect((result.match(/core-directives v\d+/g) ?? []).length).toBe(1);
    expect(result).toContain("# Persona");
  });

  it("buildCoreDirectivesBlock carries the current version and persistence line", () => {
    const block = buildCoreDirectivesBlock();
    expect(block).toContain(`v${CORE_DIRECTIVES_VERSION}`);
    expect(block).toContain("Persist learnings at milestones, unprompted.");
  });
});
