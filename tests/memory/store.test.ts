import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../src/memory/store.js";
import { openDatabase, type DatabaseType } from "../../src/memory/db.js";

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore("test-agent", { inMemory: true });
  });

  afterEach(() => {
    store.close();
  });

  describe("Constructor & Connection Management", () => {
    it("initializes with an in-memory database", () => {
      expect(store.name).toBe("test-agent");
      expect(store.rawDb.open).toBe(true);
    });

    it("can wrap an existing DatabaseType handle without owning closure", () => {
      const db: DatabaseType = openDatabase({ agentName: "wrapped-agent", inMemory: true });
      const wrappedStore = new MemoryStore("wrapped-agent", { db });
      expect(wrappedStore.rawDb).toBe(db);

      wrappedStore.close();
      // Since it did not own db, db should remain open
      expect(db.open).toBe(true);
      db.close();
    });
  });

  describe("Episode Operations", () => {
    it("adds an episode and retrieves it by id", () => {
      const ep = store.addEpisode({
        source: "action",
        content: "built the store module",
        tags: ["build", "store"],
      });
      expect(ep.id).toBeGreaterThan(0);
      expect(ep.agent_name).toBe("test-agent");
      expect(ep.source).toBe("action");
      expect(ep.content).toBe("built the store module");
      expect(ep.tags).toBe("build,store");

      const fetched = store.getEpisode(ep.id);
      expect(fetched).toEqual(ep);
    });

    it("finds memory episode by content", () => {
      const ep = store.addEpisode({
        source: "memory",
        content: "decided to use MemoryStore seam",
        tags: "decision",
      });

      const found = store.findMemoryByContent("decided to use MemoryStore seam");
      expect(found?.id).toBe(ep.id);

      const foundAlias = store.findMemoryEpisodeByContent("decided to use MemoryStore seam");
      expect(foundAlias?.id).toBe(ep.id);

      expect(store.findMemoryByContent("nonexistent")).toBeUndefined();
    });

    it("lists and counts episodes", () => {
      store.addEpisode({ source: "action", content: "ep1" });
      store.addEpisode({ source: "action", content: "ep2" });

      expect(store.countEpisodes()).toBe(2);
      const list = store.listEpisodes();
      expect(list).toHaveLength(2);
      expect(list[0]!.content).toBe("ep2");
    });

    it("deletes an episode", () => {
      const ep = store.addEpisode({ source: "action", content: "to be deleted" });
      expect(store.deleteEpisode(ep.id)).toBe(true);
      expect(store.getEpisode(ep.id)).toBeUndefined();
    });
  });

  describe("FTS Search & Consolidation Status", () => {
    it("searches history using FTS5", () => {
      store.addEpisode({ source: "memory", content: "implemented fast search using sqlite fts5" });
      store.addEpisode({ source: "memory", content: "unrelated note about refactoring" });

      const hits = store.search("sqlite fts5");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.content).toContain("sqlite fts5");
    });

    it("returns consolidation status", () => {
      const status = store.getConsolidationStatus();
      expect(status).toHaveProperty("needsConsolidation");
      expect(status).toHaveProperty("rowsSinceConsolidation");
      expect(status).toHaveProperty("nearDuplicates");
    });
  });
});
