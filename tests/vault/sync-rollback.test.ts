import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VaultSyncEngine, RollbackFailedError } from "../../src/vault/sync.js";
import { TargetAdapterEngine } from "../../src/linker/engine.js";
import { LinkGraph } from "../../src/vault/link-graph.js";
import { useMemoryFileSystem } from "../../src/utils/fs.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { createAgent } from "../../src/vault/agent.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("VaultSyncEngine rollback failure error handling", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    useMemoryFileSystem();
    tmpRoot = await mkdtemp(join(tmpdir(), "obagents-sync-rollback-test-"));
    overrideVaultRoot(tmpRoot);
  });

  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("throws original error when link fails and rollback succeeds", async () => {
    await createAgent("my-agent");
    const mockTargetEngine = new TargetAdapterEngine();

    let calls = 0;
    vi.spyOn(mockTargetEngine, "applyTargets").mockImplementation(async (_name, _dir, targets) => {
      calls++;
      if (targets[0] === "opencode") {
        throw new Error("Opencode application failed");
      }
      return [{ target: targets[0]!, key: targets[0]!, result: { action: "injected", filePath: "/mock" } }];
    });

    const mockRemove = vi.spyOn(mockTargetEngine, "removeTargets").mockResolvedValue([]);

    const mockGraph = new LinkGraph();
    const syncEngine = new VaultSyncEngine(mockTargetEngine, mockGraph);

    await expect(
      syncEngine.linkAgent("my-agent", {
        targets: ["cursor", "opencode"],
        projectDir: tmpRoot,
      }),
    ).rejects.toThrow("Opencode application failed");

    expect(mockRemove).toHaveBeenCalledWith("my-agent", tmpRoot, ["cursor"], { dryRun: false });
  });

  it("throws RollbackFailedError with orphaned targets when both link and rollback fail", async () => {
    await createAgent("my-agent");
    const mockTargetEngine = new TargetAdapterEngine();

    vi.spyOn(mockTargetEngine, "applyTargets").mockImplementation(async (_name, _dir, targets) => {
      if (targets[0] === "opencode") {
        throw new Error("Opencode apply error");
      }
      return [{ target: targets[0]!, key: targets[0]!, result: { action: "injected", filePath: "/mock" } }];
    });

    vi.spyOn(mockTargetEngine, "removeTargets").mockRejectedValue(new Error("Rollback remove error"));

    const mockGraph = new LinkGraph();
    const syncEngine = new VaultSyncEngine(mockTargetEngine, mockGraph);

    let caughtError: unknown;
    try {
      await syncEngine.linkAgent("my-agent", {
        targets: ["cursor", "opencode"],
        projectDir: tmpRoot,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(RollbackFailedError);
    const rollbackErr = caughtError as RollbackFailedError;
    expect(rollbackErr.orphanedTargets).toEqual(["cursor"]);
    expect(rollbackErr.projectDir).toBe(tmpRoot);
    expect(rollbackErr.originalError.message).toBe("Opencode apply error");
    expect(rollbackErr.message).toContain('Run "obagents unlink --target cursor"');
  });

  it("throws original error when unlink fails and recovery succeeds", async () => {
    await createAgent("my-agent");
    const mockTargetEngine = new TargetAdapterEngine();

    const mockRemove = vi.spyOn(mockTargetEngine, "removeTargets").mockRejectedValue(new Error("Remove failed"));
    const mockApply = vi.spyOn(mockTargetEngine, "applyTargets").mockResolvedValue([
      { target: "cursor", key: "cursor", result: { action: "injected", filePath: "/mock" } },
    ]);

    const mockGraph = new LinkGraph();
    const syncEngine = new VaultSyncEngine(mockTargetEngine, mockGraph);

    await expect(
      syncEngine.unlinkAgent("my-agent", {
        targets: ["cursor"],
        projectDir: tmpRoot,
      }),
    ).rejects.toThrow("Remove failed");

    expect(mockApply).toHaveBeenCalledWith("my-agent", tmpRoot, ["cursor"], expect.objectContaining({ force: true }));
  });

  it("throws RollbackFailedError with operation 'unlink' when both unlink and recovery fail", async () => {
    await createAgent("my-agent");
    const mockTargetEngine = new TargetAdapterEngine();

    vi.spyOn(mockTargetEngine, "removeTargets").mockRejectedValue(new Error("Remove failed"));
    vi.spyOn(mockTargetEngine, "applyTargets").mockRejectedValue(new Error("Recovery apply failed"));

    const mockGraph = new LinkGraph();
    const syncEngine = new VaultSyncEngine(mockTargetEngine, mockGraph);

    let caughtError: unknown;
    try {
      await syncEngine.unlinkAgent("my-agent", {
        targets: ["cursor", "roo"],
        projectDir: tmpRoot,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(RollbackFailedError);
    const rollbackErr = caughtError as RollbackFailedError;
    expect(rollbackErr.operation).toBe("unlink");
    expect(rollbackErr.orphanedTargets).toEqual(["cursor", "roo"]);
    expect(rollbackErr.projectDir).toBe(tmpRoot);
    expect(rollbackErr.originalError.message).toBe("Remove failed");
    expect(rollbackErr.message).toContain("Unlink failed and automatic recovery also failed");
    expect(rollbackErr.message).toContain('obagents diff');
  });
});
