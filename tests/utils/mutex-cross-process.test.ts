import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCrossProcessLock, isLockStale } from "../../src/utils/mutex.js";

function acquireAndWrite(lockPath: string, value: number): Promise<number> {
  // Simulate a read-modify-write that is NOT atomic: read, await, then write.
  // Only the cross-process lock prevents lost updates here.
  return withCrossProcessLock(lockPath, async () => {
    const counterPath = join(lockPath, "..", "counter.txt");
    const current = Number(readFileSync(counterPath, "utf8") || "0");
    await new Promise((r) => setTimeout(r, 5));
    const next = current + value;
    writeFileSync(counterPath, String(next), "utf8");
    return next;
  });
}

describe("withCrossProcessLock", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "obagents-mutex-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strictly serializes N concurrent acquisitions with zero interleaving", async () => {
    const lockPath = join(tmpDir, "data.lock");
    writeFileSync(join(tmpDir, "counter.txt"), "0", "utf8");

    const size = 20;
    // Launch N concurrent read-modify-write cycles against the same lock.
    const results = await Promise.all(
      Array.from({ length: size }, () => acquireAndWrite(lockPath, 1)),
    );

    // Every write observed a distinct counter value (no lost updates); the
    // order is arbitrary because contention order among concurrent waiters is
    // not deterministic, but the SET of observed values must be 1..size.
    expect([...results].sort((a, b) => a - b)).toEqual(
      Array.from({ length: size }, (_, i) => i + 1),
    );
    // Final persisted counter reflects all N increments, i.e. zero interleaving.
    expect(readFileSync(join(tmpDir, "counter.txt"), "utf8")).toBe(String(size));
  });

  it("does not reclaim a fresh unparseable lockfile, but reclaims an old one", async () => {
    // The historic race: a lock path is briefly visible EMPTY between creation
    // and the pid/ts content write. A fresh unparseable file must be treated
    // as a busy holder, not stale, or two processes can hold the lock at once.
    const freshEmpty = join(tmpDir, "fresh-empty.lock");
    writeFileSync(freshEmpty, "", "utf8");
    expect(await isLockStale(freshEmpty)).toBe(false);

    // A crashed holder's empty lockfile is reclaimable once it ages out.
    const oldEmpty = join(tmpDir, "old-empty.lock");
    writeFileSync(oldEmpty, "", "utf8");
    const { utimes } = await import("node:fs/promises");
    const oldTs = new Date(Date.now() - 60_000);
    await utimes(oldEmpty, oldTs, oldTs);
    expect(await isLockStale(oldEmpty)).toBe(true);
  });

  it("reclaims a stale lock whose recorded pid is dead", async () => {
    const lockPath = join(tmpDir, "data.lock");
    // content references a (practically) nonexistent pid: max int32
    writeFileSync(lockPath, "pid:2147483647\nts:0\n", "utf8");
    expect(existsSync(lockPath)).toBe(true);

    const value = await withCrossProcessLock(lockPath, async () => 42);

    expect(value).toBe(42);
    // Lock was released after acquisition; no lockfile remains.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a lock that is older than the stale threshold even with a live pid", async () => {
    const lockPath = join(tmpDir, "data.lock");
    // Our own live pid but with an old timestamp (> 30s stale age).
    const oldTs = Date.now() - 40_000;
    writeFileSync(lockPath, `pid:${process.pid}\nts:${oldTs}\n`, "utf8");

    const value = await withCrossProcessLock(lockPath, async () => "reclaimed");

    expect(value).toBe("reclaimed");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("cleans up the lockfile when the body throws", async () => {
    const lockPath = join(tmpDir, "data.lock");
    await expect(
      withCrossProcessLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Lock released in finally even on error.
    expect(existsSync(lockPath)).toBe(false);

    // And the lock can be re-acquired afterwards.
    await expect(withCrossProcessLock(lockPath, async () => "ok")).resolves.toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("leaves no lockfile behind after all acquisitions complete", async () => {
    const lockPath = join(tmpDir, "data.lock");
    writeFileSync(join(tmpDir, "counter.txt"), "0", "utf8");

    await Promise.all(
      Array.from({ length: 10 }, () => acquireAndWrite(lockPath, 1)),
    );

    expect(existsSync(lockPath)).toBe(false);
  });
});