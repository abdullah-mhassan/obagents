import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseType } from "../../src/memory/db.js";
import {
  addEpisode,
  searchHistory,
  listEpisodes,
  getEpisode,
  deleteEpisode,
  countEpisodes,
} from "../../src/memory/fts.js";

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase({ agentName: "test", inMemory: true });
});
afterEach(() => {
  db.close();
});

describe("addEpisode", () => {
  it("inserts a row and returns the full episode", () => {
    const ep = addEpisode(db, {
      agentName: "alpha",
      source: "consolidation",
      content: "the quick brown fox",
      tags: "archive",
    });
    expect(ep.id).toBeGreaterThan(0);
    expect(ep.agent_name).toBe("alpha");
    expect(ep.source).toBe("consolidation");
    expect(ep.content).toBe("the quick brown fox");
    expect(ep.tags).toBe("archive");
    expect(ep.created_at).toBeTruthy();
  });

  it("normalizes string-array tags to a comma string", () => {
    const ep = addEpisode(db, {
      agentName: "alpha",
      source: "action",
      content: "did a thing",
      tags: ["one", "two"],
    });
    expect(ep.tags).toBe("one,two");
  });

  it("stores null when no tags supplied", () => {
    const ep = addEpisode(db, {
      agentName: "alpha",
      source: "action",
      content: "no tags",
    });
    expect(ep.tags).toBeNull();
  });
});

describe("searchHistory (FTS5)", () => {
  beforeEach(() => {
    addEpisode(db, { agentName: "dev", source: "consolidation", content: "discussed watermelon slicing", tags: "fruit" });
    addEpisode(db, { agentName: "dev", source: "action", content: "deployed to production", tags: "ops" });
    addEpisode(db, { agentName: "qa", source: "consolidation", content: "found a bug in watermelon module", tags: "bug" });
  });

  it("returns ranked keyword matches across all agents", () => {
    const hits = searchHistory(db, "watermelon");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((h) => h.content.includes("watermelon"))).toBe(true);
  });

  it("filters by agent_name", () => {
    const hits = searchHistory(db, "watermelon", { agentName: "dev" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.agent_name).toBe("dev");
  });

  it("returns empty array for an empty query", () => {
    expect(searchHistory(db, "")).toEqual([]);
  });

  it("returns empty array when no match exists", () => {
    expect(searchHistory(db, "nonexistentterm12345")).toHaveLength(0);
  });

  it("respects the limit option", () => {
    for (let i = 0; i < 5; i++) {
      addEpisode(db, { agentName: "bulk", source: "action", content: `production deploy number ${i}` });
    }
    const hits = searchHistory(db, "production", { limit: 3 });
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it("searches across tags too", () => {
    const hits = searchHistory(db, "fruit");
    expect(hits.some((h) => h.content.includes("watermelon slicing"))).toBe(true);
  });

  it("performance: returns quickly with many episodes", () => {
    for (let i = 0; i < 2000; i++) {
      addEpisode(db, { agentName: "bulk", source: "action", content: `episode number ${i} about watermelon` });
    }
    const start = Date.now();
    const hits = searchHistory(db, "watermelon", { agentName: "bulk" });
    const elapsed = Date.now() - start;
    expect(hits.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });

  it("returns empty results for operator-only queries instead of throwing", () => {
    for (const q of ["OR", "AND NOT", "NOT", "AND"]) {
      expect(searchHistory(db, q)).toEqual([]);
    }
  });

  it("still finds results for queries mixing operators with words", () => {
    const hits = searchHistory(db, "watermelon OR fruit");
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("searchHistory recall hardening", () => {
  beforeEach(() => {
    addEpisode(db, { agentName: "dev", source: "consolidation", content: "backend-coder owns the api layer", tags: "arch" });
    addEpisode(db, { agentName: "dev", source: "action", content: "frontend-coder shipped the ui", tags: "ui" });
    addEpisode(db, { agentName: "dev", source: "action", content: "plain note about watermelons", tags: "fruit" });
  });

  it("matches a hyphenated query without throwing", () => {
    const hits = searchHistory(db, "backend-coder");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.content.includes("backend-coder owns the api"))).toBe(true);
  });

  it("recalls an Episode from a spaced multi-token query", () => {
    const hits = searchHistory(db, "backend coder");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.content.includes("backend-coder owns the api"))).toBe(true);
  });

  it("favours recall by OR-joining multi-token queries", () => {
    const hits = searchHistory(db, "backend ui");
    expect(hits.some((h) => h.content.includes("backend-coder owns the api"))).toBe(true);
    expect(hits.some((h) => h.content.includes("frontend-coder shipped the ui"))).toBe(true);
  });

  it("preserves plain single-word recall", () => {
    const hits = searchHistory(db, "watermelons");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.content.includes("watermelons"))).toBe(true);
  });

  it("fallbackRecent returns most recent Episodes ordered DESC on zero hits", () => {
    const hits = searchHistory(db, "zzz-no-such-term", { fallbackRecent: true, limit: 2 });
    expect(hits.length).toBe(2);
    expect(hits.every((h) => typeof h.rank === "number")).toBe(true);
    expect(hits[0]!.id).toBeGreaterThan(hits[1]!.id);
  });

  it("fallbackRecent default-off still returns empty on zero hits", () => {
    const hits = searchHistory(db, "zzz-no-such-term");
    expect(hits).toHaveLength(0);
  });

  it("fallbackRecent returns recent Episodes for a blank query", () => {
    const hits = searchHistory(db, "   ", { fallbackRecent: true, limit: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.id).toBeGreaterThan(hits[1]!.id);
  });

  it("returns empty for a blank query when fallback is off", () => {
    expect(searchHistory(db, "   ")).toHaveLength(0);
  });
});

describe("searchHistory fallback scoping", () => {
  const PROJ_A = "/projects/alpha";
  const PROJ_B = "/projects/beta";

  beforeEach(() => {
    addEpisode(db, { agentName: "dev", source: "memory", content: "A recent memory one", tags: `memory,${PROJ_A}` });
    addEpisode(db, { agentName: "dev", source: "memory", content: "A recent memory two", tags: `memory,${PROJ_A}` });
    addEpisode(db, { agentName: "dev", source: "memory", content: "B recent memory", tags: `memory,${PROJ_B}` });
  });

  it("fallbackRecent respects project scoping, excluding other projects", () => {
    const hits = searchHistory(db, "zzz-nope", { agentName: "dev", project: PROJ_A, fallbackRecent: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.content.includes("A recent"))).toBe(true);
    expect(hits.some((h) => h.content.includes("B recent"))).toBe(false);
  });

  it("fallbackRecent with a different project scope excludes the first project", () => {
    const hits = searchHistory(db, "zzz-nope", { agentName: "dev", project: PROJ_B, fallbackRecent: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.content.includes("B recent"))).toBe(true);
    expect(hits.some((h) => h.content.includes("A recent"))).toBe(false);
  });
});

describe("searchHistory non-Latin FTS (Arabic)", () => {
  beforeEach(() => {
    addEpisode(db, {
      agentName: "ar",
      source: "memory",
      content: "تم إصلاح السخان في المنزل اليوم",
      tags: "memory",
    });
  });

  it("matches an Arabic-only query against an Arabic memory episode", () => {
    const hits = searchHistory(db, "صيانة السخان في المنزل", { agentName: "ar" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.content.includes("السخان"))).toBe(true);
  });

  it("does not crash and yields a no-match result for absent Arabic text", () => {
    expect(() => searchHistory(db, "لا يوجد هذا المصطلح", { agentName: "ar" })).not.toThrow();
    expect(searchHistory(db, "لا يوجد هذا المصطلح", { agentName: "ar" })).toHaveLength(0);
  });
});

describe("episode CRUD helpers", () => {
  it("listEpisodes returns episodes in reverse id order", () => {
    addEpisode(db, { agentName: "a", source: "action", content: "first" });
    addEpisode(db, { agentName: "a", source: "action", content: "second" });
    const list = listEpisodes(db, "a");
    expect(list.map((e) => e.content)).toEqual(["second", "first"]);
  });

  it("getEpisode retrieves by id", () => {
    const ep = addEpisode(db, { agentName: "a", source: "action", content: "x" });
    expect(getEpisode(db, ep.id)?.content).toBe("x");
  });

  it("deleteEpisode removes the row and returns true", () => {
    const ep = addEpisode(db, { agentName: "a", source: "action", content: "gone" });
    expect(deleteEpisode(db, ep.id)).toBe(true);
    expect(getEpisode(db, ep.id)).toBeUndefined();
  });

  it("deleteEpisode clears supersedes references before deleting", () => {
    const original = addEpisode(db, { agentName: "a", source: "memory", content: "original" });
    const replacement = addEpisode(db, {
      agentName: "a",
      source: "memory",
      content: "replacement",
      supersedes: original.id,
    });
    expect(deleteEpisode(db, original.id)).toBe(true);
    expect(getEpisode(db, original.id)).toBeUndefined();
    expect(getEpisode(db, replacement.id)?.supersedes).toBeNull();
  });

  it("deleteEpisode returns false for unknown id", () => {
    expect(deleteEpisode(db, 9999)).toBe(false);
  });

  it("countEpisodes counts by agent and globally", () => {
    addEpisode(db, { agentName: "a", source: "action", content: "1" });
    addEpisode(db, { agentName: "a", source: "action", content: "2" });
    addEpisode(db, { agentName: "b", source: "action", content: "3" });
    expect(countEpisodes(db, "a")).toBe(2);
    expect(countEpisodes(db)).toBe(3);
  });
});