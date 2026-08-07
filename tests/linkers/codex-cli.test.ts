import { describe, it, expect, afterEach } from "vitest";
import {
  codexMcpArgs,
  __setCodexSpawn,
  __resetCodexSpawn,
  type CodexSpawn,
} from "../../src/linker/codex-cli.js";

/* Synchronous async-iterable of one chunk of stdio. */
function fakeStream(text: string | null) {
  if (text === null) return null;
  const source = [Buffer.from(text, "utf8")];
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () =>
        source.length
          ? { value: source.shift() as Buffer, done: false }
          : { value: undefined, done: true },
    }),
  };
}

function makeSpawn(helpText: string, exitCode = 0) {
  const spawner: CodexSpawn = (_cmd, _args, _opts) => ({
    code: Promise.resolve(exitCode),
    stdout: fakeStream(helpText) as any,
    stderr: null,
  });
  return spawner;
}

describe("codex-cli scope probing", () => {
  afterEach(() => __resetCodexSpawn());

  it("injects --scope user when the installed CLI advertises --scope", async () => {
    __setCodexSpawn(makeSpawn("--scope <scope>  the scope to use"));

    const args = await codexMcpArgs(["mcp", "add", "obagents", "--", "obagents", "serve"]);
    expect(args).toEqual(["mcp", "add", "obagents", "--scope", "user", "--", "obagents", "serve"]);
  });

  it("leaves args unchanged when the help output lacks --scope", async () => {
    __setCodexSpawn(makeSpawn("usage: codex mcp add [options]"));

    const base = ["mcp", "add", "obagents", "--", "obagents", "serve"];
    const args = await codexMcpArgs(base);
    expect(args).toEqual(base);
    expect(args).not.toContain("--scope");
  });

  it("inserts --scope right after the server-name token for mcp get", async () => {
    __setCodexSpawn(makeSpawn("--scope")); 

    const args = await codexMcpArgs(["mcp", "get", "obagents"]);
    expect(args).toEqual(["mcp", "get", "obagents", "--scope", "user"]);
  });

  it("returns base args unchanged when codex help cannot be read", async () => {
    const spawner: CodexSpawn = () =>
      ({ code: Promise.reject(new Error("no codex")), stdout: null, stderr: null });
    __setCodexSpawn(spawner);

    const base = ["mcp", "remove", "obagents"];
    const args = await codexMcpArgs(base);
    expect(args).toEqual(base);
  });
});