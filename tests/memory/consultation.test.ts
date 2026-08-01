import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { consultAgentMemory, MEMORY_ONLY_NOTE, SPARSE_CONSULT_GUIDANCE } from "../../src/memory/engine.js";
import { openDatabase, type DatabaseType } from "../../src/memory/db.js";
import { addEpisode } from "../../src/memory/fts.js";
import * as agentModule from "../../src/vault/agent.js";
import * as dbModule from "../../src/memory/db.js";

describe("consultAgentMemory", () => {
  let db: DatabaseType;
  let agentExistsSpy: any;
  let normalizeSpy: any;
  let openDbSpy: any;

  beforeEach(() => {
    db = openDatabase({ agentName: "test", inMemory: true });
    agentExistsSpy = vi.spyOn(agentModule, "agentExists").mockReturnValue(true);
    normalizeSpy = vi.spyOn(agentModule, "normalizeAgentName").mockImplementation((name) => name);
    openDbSpy = vi.spyOn(dbModule, "openDatabase").mockReturnValue(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("throws if agent does not exist", async () => {
    agentExistsSpy.mockReturnValue(false);
    await expect(consultAgentMemory("missing", "query")).rejects.toThrow('Agent "missing" does not exist.');
  });

  it("returns matched results with note and without sparse guidance if hits >= threshold", async () => {
    addEpisode(db, { agentName: "test", source: "memory", content: "we talked about apple pie" });
    addEpisode(db, { agentName: "test", source: "memory", content: "apple pie recipe" });
    
    const outcome = await consultAgentMemory("test", "apple");
    
    expect(outcome.results).toHaveLength(2);
    expect(outcome.note).toBe(MEMORY_ONLY_NOTE);
    expect(outcome.sparse).toBeUndefined();
    expect(outcome.guidance).toBeUndefined();
  });

  it("returns matched results with sparse guidance if hits < threshold", async () => {
    addEpisode(db, { agentName: "test", source: "memory", content: "just one apple" });
    
    const outcome = await consultAgentMemory("test", "apple");
    
    expect(outcome.results).toHaveLength(1);
    expect(outcome.note).toBe(MEMORY_ONLY_NOTE);
    expect(outcome.sparse).toBe(true);
    expect(outcome.guidance).toBe(SPARSE_CONSULT_GUIDANCE);
  });

  it("returns fallback results (recent) if matches == 0", async () => {
    addEpisode(db, { agentName: "test", source: "memory", content: "first memory" });
    addEpisode(db, { agentName: "test", source: "memory", content: "second memory" });
    
    const outcome = await consultAgentMemory("test", "watermelon");
    
    expect(outcome.results).toHaveLength(2);
    expect(outcome.note).toBe(MEMORY_ONLY_NOTE);
    expect(outcome.sparse).toBe(true);
    expect(outcome.guidance).toBe(SPARSE_CONSULT_GUIDANCE);
    
    // Check fallback results are returned in reverse chron order
    expect(outcome.results[0].content).toBe("second memory");
    expect(outcome.results[1].content).toBe("first memory");
  });
});
