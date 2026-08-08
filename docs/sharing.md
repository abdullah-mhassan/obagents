# Sharing & Concurrency Model

> "One brain, infinite bodies." This doc states precisely how memory is shared
> across many AI tools, what is guaranteed to be live, and what is a snapshot.

## The two layers

| Layer | Mechanism | Freshness |
|---|---|---|
| **Passive** | Compiled agent state (roster + SOUL + MEMORY + USER) injected as a marked block into tool config files (`CLAUDE.md`, `.cursor/rules/obagents.mdc`, `AGENT.md`, …) | **Snapshot** — written at `obagents link`, `obagents sync`, `obagents activate`. Does not change on its own. |
| **Active** | `obagents serve` MCP gateway (`read_state`, `update_state`, `search_history`, `consult_agent`, …) | **Live** — every call reads/writes the Vault directly. |

The passive layer is how state reaches tools that only read config files
(Cursor, Copilot, Claude Code, …). The active layer is how GUI/CLI tools read and
write the same brain in real time.

## When do the other tools see a new memory?

1. `update_state` records an episode in the FTS5 deep store **and** mirrors a
   `- <type>: <summary>` bullet into the project-scoped `MEMORY.md` under
   `## Latest state` (idempotent; refused if it would exceed `MEMORY_CHAR_LIMIT`).
2. The gateway sees it immediately (`search_history` / `consult_agent` are live).
3. The **passive** config files see it at the next `obagents sync` — the compiler
   reads `MEMORY.md`, so the mirrored bullets are included in the re-compiled
   block. Until then, the on-disk block is the previous snapshot.

Use `obagents diff` to see drift between the injected block and the freshly
compiled state; `obagents sync` re-applies it.

## Concurrency guarantees

- **Cross-process write lock.** `project.json` (`.obagents-project.json`),
  `agents.json`, and per-agent `agent.json` writes are serialized across OS
  processes via an exclusive lockfile (`<store>.lock`, `O_EXCL` create, owner
  `pid`+`ts` written and `fsync`ed). Stale locks (dead owner pid, or older than
  30 s) are reclaimed; acquisition retries with jittered backoff. This makes
  two `obagents serve` gateways or concurrent CLI invocations on the same
  project safe against lost read-modify-write updates.
- **In-process fast path.** The existing `withLock` promise-chain still
  serializes callers inside one process; the file lock is acquired first and
  released last, so ordering is preserved.
- **Episodic store (SQLite).** `better-sqlite3` is a single-connection,
  single-writer driver per process. WAL mode plus `busy_timeout = 5000` make
  reads concurrent; concurrent *writers* from separate processes queue at the
  DB level and may raise `SQLITE_BUSY` under heavy contention. `update_state`
  is an append-only insert (low risk); `consolidate` is read-modify-write and
  should not be run concurrently from multiple processes.

## Honest limitations

- Passive config files are **snapshots by design** — nothing watches them.
  If you want near-live injection, re-run `obagents sync` (or use the gateway).
- The three metadata stores are locked per-store, not as one atomic
  transaction. A hard crash mid `link`/`unlink` can still leave metadata
  partially updated; the registry + `obagents diff`/`sync` repair path is the
  recovery mechanism.
- Lock files live next to their target (`<store>.lock`) and are unlinked on
  release and on process exit. A `SIGKILL` can leave one behind; the next
  writer reclaims it via stale-lock recovery.
