import { promises as fsp } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMemoryFileSystem } from "./fs.js";

const chains = new Map<string, Promise<unknown>>();

/**
 * Serialize jobs per key through a promise chain. `fn` runs only after every
 * previously queued job for the same key has settled, so read-modify-write
 * cycles keyed by the same path cannot interleave. Errors propagate to the
 * caller while the chain itself stays alive for subsequent jobs.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  chains.set(key, result.then(() => undefined, () => undefined));
  return result;
}

// ---------------------------------------------------------------------------
// Cross-process file lock
//
// `withCrossProcessLock` serializes writers across *separate OS processes*
// (e.g. two `obagents serve` MCP gateways or concurrent CLI invocations
// touching the same project/registry/agent metadata). It is backed by an
// exclusive lockfile: the winner is the only process that can create the lock
// path with O_EXCL (`"wx"`). Contenders poll with a small jittered backoff and
// release by unlinking the lock file, so a crash leaves a stale lock behind
// that must be recovered (see `isLockStale`).
// ---------------------------------------------------------------------------

/** A lockfile is considered stale after this age even if its owner pid looks alive. */
const STALE_AGE_MS = 30_000;
/** Backoff base for retrying a contended lock (doubles per attempt, capped). */
const BACKOFF_BASE_MS = 10;
const BACKOFF_MAX_MS = 100;

// Lock paths currently held by THIS process, so we can best-effort unlink them
// on 'exit'/SIGINT and avoid leaving cruft behind.
const heldLockPaths = new Set<string>();
let cleanupRegistered = false;
// Ensures every acquisition attempt gets a unique temp-file name even when
// many attempts from the same process land in the same millisecond — a shared
// name would let one attempt's cleanup unlink another attempt's not-yet-linked
// temp file (ENOENT on link).
let acquireAttemptSeq = 0;

function registerLockCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = (): void => {
    heldLockPaths.forEach((lockPath) => {
      fsp.unlink(lockPath).catch(() => undefined);
    });
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function parseLockOwner(content: string): { pid: number; ts: number } | null {
  const match = /^pid:(\d+)\nts:(\d+)/.exec(content);
  if (!match) return null;
  return { pid: Number(match[1]), ts: Number(match[2]) };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH (no such process) / EINVAL => not alive. EPERM => alive but owned
    // by another user, so we must treat it as live.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock file is stale if its recorded owner is dead or it is too old. */
export async function isLockStale(lockPath: string): Promise<boolean> {
  let content: string;
  try {
    content = await fsp.readFile(lockPath, "utf8");
  } catch {
    // ENOENT => already reclaimed/released; nothing to recover.
    return false;
  }
  const info = parseLockOwner(content);
  if (!info) {
    // The lock file exists but does not parse as a pid/ts record. This used to
    // happen mid-acquisition: the previous implementation created the file
    // with open("wx") and wrote the pidfile content afterwards, so a contender
    // could read the empty file and reclaim a LIVE lock (granting two holders).
    // Acquisition is now atomic (temp file + hard link), so an unparseable
    // file can only be the remnant of a crashed holder; only reclaim it once
    // it is older than the stale threshold, otherwise it is a busy holder.
    const stat = await fsp.stat(lockPath).catch(() => null);
    return stat !== null && Date.now() - stat.mtimeMs > STALE_AGE_MS;
  }
  if (!isPidAlive(info.pid)) return true;
  return Date.now() - info.ts > STALE_AGE_MS;
}

async function sleepBackoff(attempt: number): Promise<void> {
  // Jittered exponential backoff with a cap.
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  await sleep(base + Math.random() * base);
}

/**
 * Acquire an exclusive lock on `lockPath` across OS processes, run `fn`, and
 * release. Stale locks (dead owner pid or age > STALE_AGE_MS) are reclaimed.
 * The lock is released in a `finally` so even thrown errors never wedge future
 * writers, and best-effort unlink-on-exit cleanup avoids leaving stale locks.
 */
export async function withCrossProcessLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  // A memory-backed file system only exists within this process, so there is
  // nothing to serialize across OS processes; fall back to running `fn`
  // directly (the in-process `withLock` wrapper still serializes callers).
  if (isMemoryFileSystem()) {
    return fn();
  }

  const resolved = resolve(lockPath);
  await fsp.mkdir(dirname(resolved), { recursive: true });
  registerLockCleanup();

  let acquired = false;
  try {
    let attempt = 0;
    const content = `pid:${process.pid}\nts:${Date.now()}\n`;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Create the pidfile atomically: write to a temp file in the same
      // directory, then hard-link it into place. A plain open("wx") would
      // leave the lock path visible EMPTY between creation and the content
      // write, and a contender could read that empty file, misjudge it stale,
      // and reclaim a lock still held by a live owner (two holders => lost
      // updates under cross-process contention). link() is atomic and fails
      // with EEXIST when the lock path exists, preserving exclusive semantics.
      const tmpPath = `${resolved}.${process.pid}.${Date.now()}.${acquireAttemptSeq++}.tmp`;
      await fsp.writeFile(tmpPath, content, "utf8");
      try {
        await fsp.link(tmpPath, resolved);
        acquired = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        // Contended: recover any truly stale lock, then back off and retry.
        if (await isLockStale(resolved)) {
          await fsp.unlink(resolved).catch(() => undefined);
          continue;
        }
        await sleepBackoff(attempt);
        attempt += 1;
      } finally {
        await fsp.unlink(tmpPath).catch(() => undefined);
      }
    }
    heldLockPaths.add(resolved);
    return await fn();
  } finally {
    heldLockPaths.delete(resolved);
    if (acquired) {
      await fsp.unlink(resolved).catch(() => undefined);
    }
  }
}