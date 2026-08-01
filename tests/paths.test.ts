import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { overrideVaultRoot, getVaultRoot, getAgentDir, pathResolver } from "../src/utils/paths.js";
import { getProjectHash, findProjectRoot, getCoreFilePath, ensureProjectMemoryExists } from "../src/vault/project.js";

describe("paths utility", () => {
  describe("getVaultRoot", () => {
    const originalEnv = process.env.OBAGENTS_VAULT_DIR;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.OBAGENTS_VAULT_DIR = originalEnv;
      } else {
        delete process.env.OBAGENTS_VAULT_DIR;
      }
      overrideVaultRoot(null);
    });

    it("respects OBAGENTS_VAULT_DIR environment variable when set", () => {
      process.env.OBAGENTS_VAULT_DIR = "/custom/env/vault";
      expect(getVaultRoot()).toBe("/custom/env/vault");
    });

    it("prioritizes programmatically set vaultRootOverride over OBAGENTS_VAULT_DIR", () => {
      process.env.OBAGENTS_VAULT_DIR = "/custom/env/vault";
      overrideVaultRoot("/override/vault");
      expect(getVaultRoot()).toBe("/override/vault");
    });
  });

  describe("PathResolver", () => {
    afterEach(() => {
      pathResolver.reset();
    });

    it("defaults to OS home directory and standard app target paths", () => {
      expect(pathResolver.getHomeDir()).toBe(homedir());
      expect(pathResolver.getWindsurfMcpPath()).toContain(".codeium");
      expect(pathResolver.getContinueMcpPath()).toContain(".continue");
      expect(pathResolver.getAntigravityMcpPath()).toContain(".gemini");
      expect(pathResolver.getClaudeSettingsPath()).toContain(".claude");
    });

    it("allows setting home directory override", () => {
      pathResolver.setHomeDir("/tmp/fake-home");
      expect(pathResolver.getHomeDir()).toBe("/tmp/fake-home");
      expect(pathResolver.getWindsurfMcpPath()).toBe("/tmp/fake-home/.codeium/windsurf/mcp_config.json");
      expect(pathResolver.getContinueMcpPath()).toBe("/tmp/fake-home/.continue/config.json");
      expect(pathResolver.getAntigravityMcpPath()).toBe("/tmp/fake-home/.gemini/config/mcp_config.json");
      expect(pathResolver.getClaudeSettingsPath()).toBe("/tmp/fake-home/.claude/settings.json");
    });

    it("allows overriding individual target paths", () => {
      pathResolver.setTargetPath("windsurf", "/custom/windsurf/mcp.json");
      expect(pathResolver.getWindsurfMcpPath()).toBe("/custom/windsurf/mcp.json");
      expect(pathResolver.getContinueMcpPath()).toContain(".continue");
    });

    it("resets overrides back to defaults", () => {
      pathResolver.setHomeDir("/tmp/fake-home");
      pathResolver.setTargetPath("windsurf", "/custom/path");
      pathResolver.reset();
      expect(pathResolver.getHomeDir()).toBe(homedir());
      expect(pathResolver.getWindsurfMcpPath()).toContain(".codeium");
    });
  });

  describe("getProjectHash", () => {
    it("generates a stable 12-character hex hash", () => {
      const hash1 = getProjectHash("/projects/my-app");
      expect(hash1).toMatch(/^[0-9a-f]{12}$/);
    });

    it("preserves casing on POSIX and ignores casing on Windows", () => {
      const originalPlatform = process.platform;
      try {
        // Mock Windows
        Object.defineProperty(process, "platform", {
          value: "win32",
          configurable: true,
        });
        const winHash1 = getProjectHash("/projects/My-App");
        const winHash2 = getProjectHash("/projects/my-app");
        expect(winHash1).toBe(winHash2);

        // Mock POSIX (Linux)
        Object.defineProperty(process, "platform", {
          value: "linux",
          configurable: true,
        });
        const nixHash1 = getProjectHash("/projects/My-App");
        const nixHash2 = getProjectHash("/projects/my-app");
        expect(nixHash1).not.toBe(nixHash2);
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it("normalizes path separators (Windows vs POSIX)", () => {
      const hash1 = getProjectHash("C:\\projects\\my-app");
      const hash2 = getProjectHash("C:/projects/my-app");
      expect(hash1).toBe(hash2);
    });
  });

  describe("getCoreFilePath", () => {
    it("returns project-scoped path only for MEMORY.md when projectDir is provided", () => {
      const globalSoul = getCoreFilePath("my-agent", "SOUL.md", "/projects/app");
      expect(globalSoul).toContain("/agents/my-agent/SOUL.md");
      expect(globalSoul).not.toContain("/projects/");

      const scopedMemory = getCoreFilePath("my-agent", "MEMORY.md", "/projects/app");
      expect(scopedMemory).toContain("/agents/my-agent/projects/");
      expect(scopedMemory).toContain("/MEMORY.md");
    });

    it("returns global path when projectDir is omitted", () => {
      const globalMemory = getCoreFilePath("my-agent", "MEMORY.md");
      expect(globalMemory).toContain("/agents/my-agent/MEMORY.md");
      expect(globalMemory).not.toContain("/projects/");
    });
  });

  describe("findProjectRoot", () => {
    let tmpRoot: string;

    beforeEach(async () => {
      tmpRoot = await mkdtemp(join(tmpdir(), "obagents-find-root-"));
    });

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("returns null if no project configuration is found", () => {
      expect(findProjectRoot(tmpRoot)).toBeNull();
    });

    it("returns the directory containing .obagents-project.json", async () => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(tmpRoot, ".obagents-project.json"), "{}");
      expect(findProjectRoot(tmpRoot)).toBe(tmpRoot);
    });

    it("climbs up to find the project root", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const subDir = join(tmpRoot, "a", "b", "c");
      await mkdir(subDir, { recursive: true });
      await writeFile(join(tmpRoot, ".obagents-project.json"), "{}");
      
      expect(findProjectRoot(subDir)).toBe(tmpRoot);
    });
  });

  describe("ensureProjectMemoryExists", () => {
    let tmpRoot: string;

    beforeEach(async () => {
      tmpRoot = await mkdtemp(join(tmpdir(), "obagents-paths-test-"));
      overrideVaultRoot(tmpRoot);
    });

    afterEach(async () => {
      overrideVaultRoot(null);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("lazily creates project directory, instantiates template and project.json, and returns MEMORY.md path", async () => {
      const agentName = "test-agent";
      const projectDir = "/my/cool/project";

      const memoryPath = await ensureProjectMemoryExists(agentName, projectDir);
      expect(memoryPath).toContain("projects");
      expect(memoryPath).toContain("MEMORY.md");
      expect(existsSync(memoryPath)).toBe(true);

      const memoryContent = readFileSync(memoryPath, "utf8");
      expect(memoryContent).toContain("# Working Memory");

      const projectJsonPath = join(dirname(memoryPath), "project.json");
      expect(existsSync(projectJsonPath)).toBe(true);

      const projectJson = JSON.parse(readFileSync(projectJsonPath, "utf8"));
      expect(projectJson.path).toBe(projectDir);
      expect(projectJson.linkedAt).toBeDefined();
      expect(new Date(projectJson.linkedAt).getTime()).not.toBeNaN();
    });

    it("preserves linkedAt timestamp if project.json already exists", async () => {
      const agentName = "test-agent";
      const projectDir = "/my/cool/project";

      const memoryPath1 = await ensureProjectMemoryExists(agentName, projectDir);
      const projectJsonPath = join(dirname(memoryPath1), "project.json");
      const initialJson = JSON.parse(readFileSync(projectJsonPath, "utf8"));
      const firstTimestamp = initialJson.linkedAt;

      // Wait a bit to ensure a potential new timestamp would be different
      await new Promise((r) => setTimeout(r, 10));

      const memoryPath2 = await ensureProjectMemoryExists(agentName, projectDir);
      const secondJson = JSON.parse(readFileSync(projectJsonPath, "utf8"));
      expect(secondJson.linkedAt).toBe(firstTimestamp);
    });
  });
});
