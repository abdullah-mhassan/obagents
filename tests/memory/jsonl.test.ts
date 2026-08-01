import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { openDatabase } from "../../src/memory/db.js";
import { addEpisode } from "../../src/memory/fts.js";
import { getJsonlPath } from "../../src/memory/jsonl.js";
import { overrideVaultRoot } from "../../src/utils/paths.js";

describe("JSONL mirror", () => {
  const tmpVault = "/tmp/obagents-jsonl-test";

  beforeEach(() => {
    overrideVaultRoot(tmpVault);
    mkdirSync(tmpVault, { recursive: true });
  });

  afterEach(() => {
    overrideVaultRoot(null);
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it("skips mirroring for in-memory databases", () => {
    const db = openDatabase({ agentName: "test-agent", inMemory: true });
    addEpisode(db, { agentName: "test-agent", source: "memory", content: "hello in memory" });
    db.close();

    const path = getJsonlPath("test-agent");
    expect(existsSync(path)).toBe(false);
  });

  it("writes mirror episode to jsonl for file-backed databases", async () => {
    const dbPath = `${tmpVault}/state.db`;
    const db = openDatabase({ agentName: "test-agent", path: dbPath });
    const ep1 = addEpisode(db, { agentName: "test-agent", source: "memory", content: "first entry" });
    const ep2 = addEpisode(db, { agentName: "test-agent", source: "memory", content: "second entry", supersedes: ep1.id });
    db.close();

    await new Promise((r) => setTimeout(r, 50));

    const path = getJsonlPath("test-agent");
    expect(existsSync(path)).toBe(true);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);

    const parsed1 = JSON.parse(lines[0]!);
    expect(parsed1.id).toBe(ep1.id);
    expect(parsed1.content).toBe("first entry");

    const parsed2 = JSON.parse(lines[1]!);
    expect(parsed2.id).toBe(ep2.id);
    expect(parsed2.supersedes).toBe(ep1.id);
  });
});
