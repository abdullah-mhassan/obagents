import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideVaultRoot } from "../../src/utils/paths.js";
import { createAgent } from "../../src/vault/agent.js";
import { openDatabase } from "../../src/memory/db.js";
import { createConsolidateCommand } from "../../src/commands/consolidate.js";
import { logger } from "../../src/utils/logger.js";

let tmpRoot: string;

describe("consolidate command overflow warning", () => {
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "obagents-cons-cmd-"));
    overrideVaultRoot(tmpRoot);
    process.exitCode = 0;
  });

  afterEach(async () => {
    overrideVaultRoot(null);
    await rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("warns about unconsolidated entries rather than character count when consolidation is due", async () => {
    await createAgent("tester");
    const db = openDatabase({ agentName: "tester" });
    for (let i = 0; i < 20; i++) {
      db.prepare(
        "INSERT INTO episodes (agent_name, source, content, tags) VALUES (?, 'memory', ?, ?)",
      ).run("tester", `distinct memory entry ${i}`, "milestone,__global__");
    }
    db.close();

    const warningSpy = vi.spyOn(logger, "warning").mockImplementation(() => {});
    const command = createConsolidateCommand();
    await command.parseAsync(["tester", "--summary", "short summary"], { from: "user" });

    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("unconsolidated"));
    expect(warningSpy.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.not.arrayContaining([expect.stringContaining("soft limit")]),
    );
  });
});
