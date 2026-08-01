import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { runCommand, fail, selectAgent, CommandError } from "../../src/commands/runner.js";
import { logger } from "../../src/utils/logger.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "obagents-runner-"));
  overrideVaultRoot(tmpRoot);
  process.exitCode = 0;
});

afterEach(async () => {
  overrideVaultRoot(null);
  await rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("CommandError / fail", () => {
  it("fail throws a CommandError", () => {
    expect(() => fail("boom")).toThrow(CommandError);
    expect(() => fail("boom")).toThrow("boom");
  });
});

describe("runCommand", () => {
  it("lets a clean action resolve without setting exit code", async () => {
    const action = runCommand(async () => {
      /* noop */
    });
    await action();
    expect(process.exitCode).toBe(0);
  });

  it("catches thrown errors, logs the message, and sets exit code 1", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const action = runCommand(async () => {
      throw new Error("kaboom");
    });
    await action();
    expect(spy).toHaveBeenCalledWith("kaboom");
    expect(process.exitCode).toBe(1);
  });

  it("coerces non-Error throws to a string message", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const action = runCommand(async () => {
      throw "string failure";
    });
    await action();
    expect(spy).toHaveBeenCalledWith("string failure");
    expect(process.exitCode).toBe(1);
  });
});

describe("selectAgent", () => {
  it("fails when the vault has no agents", async () => {
    await expect(selectAgent("Pick:")).rejects.toThrow(CommandError);
  });
});
