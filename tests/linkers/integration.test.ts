import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../src/vault/agent.js";
import { getAgentMeta } from "../../src/vault/metadata.js";
import { vaultSyncEngine } from "../../src/vault/sync.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";

const linkAgent = vaultSyncEngine.linkAgent.bind(vaultSyncEngine);
const unlinkAgent = vaultSyncEngine.unlinkAgent.bind(vaultSyncEngine);


let tmpRoot: string;
let projectA: string;
let projectB: string;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("linker orchestrator (integration)", () => {
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "obagents-int-"));
    overrideVaultRoot(tmpRoot);
    projectA = join(tmpRoot, "projectA");
    projectB = join(tmpRoot, "projectB");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    // Production code canonicalizes project paths via realpathSync (src/vault/project.ts)
    // for real-symlink support. On macOS, os.tmpdir() resolves under /var, which is itself
    // a symlink to /private/var — match that canonicalization here so equality assertions
    // against these paths compare like with like.
    projectA = await realpath(projectA);
    projectB = await realpath(projectB);
    await createAgent("dev");
  });
  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("links a specific target and records the link in agent.json", async () => {
    const outcome = await linkAgent("dev", { projectDir: projectA, targets: ["cursor"] });
    expect(outcome.results).toHaveLength(1);
    expect(await exists(join(projectA, ".cursor/rules/obagents.mdc"))).toBe(true);

    const meta = await getAgentMeta("dev");
    expect(meta?.links.find((l) => l.projectDir === projectA)?.targets).toContain("cursor");
    expect(meta?.links.map((l) => l.projectDir)).toContain(projectA);
  });

  it("writes the Hive Protocol into the generated roster", async () => {
    await linkAgent("dev", { projectDir: projectA, targets: ["cursor"] });
    const content = await readFile(join(projectA, ".cursor/rules/obagents.mdc"), "utf8");
    expect(content).toContain("## Hive Protocol");
    expect(content).toContain("consult_agent");
  });

  it("re-linking is idempotent (no duplicate markers)", async () => {
    await linkAgent("dev", { projectDir: projectA, targets: ["generic"] });
    await linkAgent("dev", { projectDir: projectA, targets: ["generic"] });
    const content = await readFile(join(projectA, "AGENT.md"), "utf8");
    expect((content.match(/obagents:start/g) || []).length).toBe(1);
  });

  it("dry-run writes nothing but reports the action", async () => {
    const outcome = await linkAgent("dev", { projectDir: projectA, targets: ["generic"], dryRun: true });
    expect(outcome.results[0]!.result.action).toBe("created");
    expect(await exists(join(projectA, "AGENT.md"))).toBe(false);
  });

  it("rejects an unsupported target with an actionable error", async () => {
    await expect(linkAgent("dev", { projectDir: projectA, targets: ["ghost-tool"] })).rejects.toThrow(
      /Unsupported target "ghost-tool"/,
    );
  });

  it("errors when no target can be detected", async () => {
    await expect(linkAgent("dev", { projectDir: projectA })).rejects.toThrow(/No target specified/);
  });

  it("unlink removes the standalone file and clears registry entry", async () => {
    await linkAgent("dev", { projectDir: projectA, targets: ["generic"] });
    await unlinkAgent("dev", { projectDir: projectA, targets: ["generic"] });
    expect(await exists(join(projectA, "AGENT.md"))).toBe(false);
    const meta = await getAgentMeta("dev");
    expect(meta?.links.find((l) => l.projectDir === projectA)?.targets ?? []).not.toContain("generic");
  });

  it("unlink preserves user content in shared files", async () => {
    const shared = join(projectA, ".windsurfrules");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(shared, "user rules\n", "utf8");
    await linkAgent("dev", { projectDir: projectA, targets: ["windsurf"] });
    await unlinkAgent("dev", { projectDir: projectA, targets: ["windsurf"] });
    const remaining = await readFile(shared, "utf8");
    expect(remaining).toContain("user rules");
    expect(remaining).not.toContain("obagents");
  });

  it("links to multiple projects and re-distributes updated content across both", async () => {
    await linkAgent("dev", { projectDir: projectA, targets: ["generic"] });
    await linkAgent("dev", { projectDir: projectB, targets: ["generic"] });
    const meta = await getAgentMeta("dev");
    expect(meta?.links.map((l) => l.projectDir)).toEqual(expect.arrayContaining([projectA, projectB]));

    // Instead of testing SOUL.md inclusion (which was removed in the orchestrator model),
    // we test that linking a new agent to the projects updates their hive roster.
    await createAgent("dev2");
    
    for (const project of [projectA, projectB]) {
      await linkAgent("dev2", { projectDir: project, targets: ["generic"], force: true });
    }
    const aContent = await readFile(join(projectA, "AGENT.md"), "utf8");
    const bContent = await readFile(join(projectB, "AGENT.md"), "utf8");
    expect(aContent).toContain("@dev2");
    expect(bContent).toContain("@dev2");
  });
});
