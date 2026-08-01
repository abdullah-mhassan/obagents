import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/memory/db.js";
import { addEpisode } from "../../src/memory/fts.js";
import { generateMemoryTree } from "../../src/memory/tree.js";
import { encodeProjectTag } from "../../src/memory/project-tag.js";
import type { DatabaseType } from "../../src/memory/db.js";

describe("generateMemoryTree (ADR 0005 Curated Memory Tree)", () => {
  let db: DatabaseType;
  const agentName = "tree-agent";

  beforeEach(() => {
    db = openDatabase({ agentName, inMemory: true });
  });

  afterEach(() => {
    if (db) db.close();
  });

  it("renders empty state messages when no episodes exist", () => {
    const markdown = generateMemoryTree(agentName, { db });
    expect(markdown).toContain(`# Memory Tree: ${agentName}`);
    expect(markdown).toContain("## 📦 Skills");
    expect(markdown).toContain("_No skills recorded._");
    expect(markdown).toContain("## 🧠 Active Knowledge");
    expect(markdown).toContain("_No active knowledge recorded._");
    expect(markdown).toContain("## 📜 Consolidated Milestones");
    expect(markdown).toContain("_No consolidated milestones recorded._");
    expect(markdown).toContain("## 🛠️ Recent Tool Operations");
    expect(markdown).toContain("_No recent tool operations recorded._");
  });

  it("categorizes episodes correctly into Skills, Active Knowledge, Consolidations, and Tool Operations", () => {
    addEpisode(db, { agentName, source: "skill", content: "Python debugging pattern", tags: "skill" });
    const ep1 = addEpisode(db, { agentName, source: "memory", content: "Architecture decision 1" });
    addEpisode(db, {
      agentName,
      source: "memory",
      content: "Architecture decision 2 (supersedes 1)",
      supersedes: ep1.id,
    });
    addEpisode(db, { agentName, source: "consolidation", content: "Phase 1 consolidation summary" });
    addEpisode(db, { agentName, source: "tool-call", content: "Ran git diff on codebase" });

    const markdown = generateMemoryTree(agentName, { db });

    expect(markdown).toContain("## 📦 Skills");
    expect(markdown).toContain("Python debugging pattern");

    expect(markdown).toContain("## 🧠 Active Knowledge");
    expect(markdown).toContain("Architecture decision 2 (supersedes 1)");
    // Should NOT list superseded decision 1 in Active Knowledge
    expect(markdown).not.toContain("Architecture decision 1");

    expect(markdown).toContain("## 📜 Consolidated Milestones");
    expect(markdown).toContain("Phase 1 consolidation summary");

    expect(markdown).toContain("## 🛠️ Recent Tool Operations");
    expect(markdown).toContain("Ran git diff on codebase");
  });

  it("lists global skills in a project-scoped tree while filtering other sections by project tag", () => {
    addEpisode(db, { agentName, source: "skill", content: "Global debugging pattern", tags: "skill" });
    addEpisode(db, {
      agentName,
      source: "memory",
      content: "Alpha project decision",
      tags: encodeProjectTag("decision", "/projects/alpha"),
    });
    addEpisode(db, {
      agentName,
      source: "memory",
      content: "Beta project decision",
      tags: encodeProjectTag("decision", "/projects/beta"),
    });
    addEpisode(db, {
      agentName,
      source: "consolidation",
      content: "Alpha consolidation summary",
      tags: encodeProjectTag("consolidation", "/projects/alpha"),
    });
    addEpisode(db, {
      agentName,
      source: "consolidation",
      content: "Beta consolidation summary",
      tags: encodeProjectTag("consolidation", "/projects/beta"),
    });
    addEpisode(db, {
      agentName,
      source: "tool-call",
      content: "Ran tests in alpha",
      tags: encodeProjectTag("tool-call", "/projects/alpha"),
    });

    const markdown = generateMemoryTree(agentName, { db, projectDir: "/projects/alpha" });

    expect(markdown).toContain("Global debugging pattern");
    expect(markdown).toContain("Alpha project decision");
    expect(markdown).not.toContain("Beta project decision");
    expect(markdown).toContain("Alpha consolidation summary");
    expect(markdown).not.toContain("Beta consolidation summary");
    expect(markdown).toContain("Ran tests in alpha");
  });
});
