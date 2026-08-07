// Codex CLI shape probing.
//
// Whether the installed Codex CLI supports a `--scope` flag varies across
// releases (some recent versions reject it as unknown). Instead of hard-coding
// `--scope user`, we probe the installed CLI once per process
// (`codex mcp add --help`) and only inject `--scope user` when that flag is
// explicitly advertised. Where the help cannot be read or mentions no
// `--scope`, we default to NOT injecting it (plain args — the fail-safe
// direction).
import { spawn } from "node:child_process";

export interface CodexSpawnResult {
  code: Promise<number | null>;
  stdout: AsyncIterable<Uint8Array> | null;
  stderr: AsyncIterable<Uint8Array> | null;
}

export type CodexSpawn = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => CodexSpawnResult;

function defaultSpawn(cmd: string, args: string[], opts: { cwd: string }): CodexSpawnResult {
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
  const code = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (c) => resolve(c));
  });
  return {
    code,
    stdout: child.stdout as AsyncIterable<Uint8Array> | null,
    stderr: child.stderr as AsyncIterable<Uint8Array> | null,
  };
}

let codexSpawn: CodexSpawn = defaultSpawn;

/**
 * Test seam: replace the spawner used by this module. Consumers (non-test
 * code) should never call this.
 */
export function __setCodexSpawn(fn: CodexSpawn): void {
  codexSpawn = fn;
}

/** Test seam: restore the real spawner and clear the scope-probe cache. */
export function __resetCodexSpawn(): void {
  codexSpawn = defaultSpawn;
  scopeSupported = null;
}

async function collectText(stream: AsyncIterable<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  let out = "";
  for await (const chunk of stream) {
    out += Buffer.from(chunk).toString("utf8");
  }
  return out;
}

/**
 * Spawn `codex <args>` capturing stdout/stderr. Resolves with stdout on exit
 * code 0; rejects otherwise.
 */
export async function runCodexCapture(
  args: string[],
  cwdOverride?: string,
): Promise<string> {
  const cwd = cwdOverride ?? process.cwd();
  const spawned = codexSpawn("codex", args, { cwd });
  const outP = collectText(spawned.stdout);
  const errP = collectText(spawned.stderr);
  const exit = await spawned.code;
  const [out, err] = await Promise.all([outP, errP]);
  if (exit !== 0) {
    throw new Error(`codex exited with code ${exit}: ${err.trim()}`);
  }
  return out;
}

let scopeSupported: boolean | null = null;

/**
 * Probe once per process whether the installed Codex CLI advertises a
 * `--scope` flag. Any read failure (spawn error, nonzero exit) is treated as
 * "not supported" and cached. A nonzero-exit probe result is never cached as
 * supported.
 */
export async function detectScopeSupport(cwdOverride?: string): Promise<boolean> {
  if (scopeSupported !== null) return scopeSupported;

  let help: string;
  try {
    help = await runCodexCapture(["mcp", "add", "--help"], cwdOverride);
  } catch {
    scopeSupported = false;
    return scopeSupported;
  }

  // Treat "cannot confidently see --scope advertised" as NOT supported (the
  // fail-safe direction): if we can't read the help, or the help text makes no
  // mention, we keep the args plain so a CLI that rejects `--scope` is never
  // fed a flag it will fail on.
  scopeSupported = /(?:^|[\s])--scope\b/.test(help);
  return scopeSupported;
}

/**
 * Return `args` unchanged, unless the installed CLI advertises `--scope`, in
 * which case insert `["--scope", "user"]` immediately after the `"obagents"`
 * server-name token.
 */
export async function codexMcpArgs(
  args: string[],
  cwdOverride?: string,
): Promise<string[]> {
  if (!(await detectScopeSupport(cwdOverride))) {
    return [...args];
  }
  const idx = args.indexOf("obagents");
  if (idx < 0) return [...args];
  return [
    ...args.slice(0, idx + 1),
    "--scope",
    "user",
    ...args.slice(idx + 1),
  ];
}