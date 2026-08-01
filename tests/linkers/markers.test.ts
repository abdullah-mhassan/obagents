import { describe, it, expect } from "vitest";
import {
  buildBlock,
  hasBlock,
  injectBlock,
  removeBlock,
  removeLegacyBlock,
  hasLegacyBlock,
  hasAgentScopedBlock,
} from "../../src/linker/markers.js";

const legacyHiveBlock = `<!-- obagents:start agent="hive" generated="2026-01-01T00:00:00.000Z" -->
legacy hive content
<!-- obagents:end -->`;

const legacyNoAgentBlock = `<!-- obagents:start generated="2026-01-01T00:00:00.000Z" -->
legacy anon content
<!-- obagents:end -->`;

describe("markers: agent-scoped block identity", () => {
  it("injectBlock appends a second agent's block without touching the first", () => {
    const blockA = buildBlock("contentA", "alpha");
    const blockB = buildBlock("contentB", "beta");
    const once = injectBlock("", blockA, "alpha");
    const twice = injectBlock(once, blockB, "beta");
    expect(hasBlock(twice, "alpha")).toBe(true);
    expect(hasBlock(twice, "beta")).toBe(true);
    expect((twice.match(/obagents:start/g) || []).length).toBe(2);
    expect(twice).toContain("contentA");
    expect(twice).toContain("contentB");
  });

  it("injectBlock replaces only the same agent's block on re-link", () => {
    const blockA1 = buildBlock("versionA1", "alpha");
    const blockA2 = buildBlock("versionA2", "alpha");
    const blockB = buildBlock("contentB", "beta");
    const content = injectBlock(injectBlock("", blockA1, "alpha"), blockB, "beta");
    const updated = injectBlock(content, blockA2, "alpha");
    expect(hasBlock(updated, "alpha")).toBe(true);
    expect(hasBlock(updated, "beta")).toBe(true);
    expect((updated.match(/obagents:start/g) || []).length).toBe(2);
    expect(updated).toContain("versionA2");
    expect(updated).not.toContain("versionA1");
    expect(updated).toContain("contentB");
  });

  it("removeBlock removes exactly the owning agent's block", () => {
    const blockA = buildBlock("contentA", "alpha");
    const blockB = buildBlock("contentB", "beta");
    const content = injectBlock(injectBlock("", blockA, "alpha"), blockB, "beta");
    const cleaned = removeBlock(content, "alpha");
    expect(cleaned).not.toContain("contentA");
    expect(cleaned).toContain("contentB");
    expect(hasBlock(cleaned, "beta")).toBe(true);
  });

  it("detects legacy blocks (agent=\"hive\" or missing agent attribute)", () => {
    expect(hasLegacyBlock(legacyHiveBlock)).toBe(true);
    expect(hasLegacyBlock(legacyNoAgentBlock)).toBe(true);
    expect(hasLegacyBlock(buildBlock("x", "alpha"))).toBe(false);
    expect(hasAgentScopedBlock(buildBlock("x", "alpha"))).toBe(true);
    expect(hasAgentScopedBlock(legacyHiveBlock)).toBe(false);
  });

  it("injectBlock migrates a legacy agent=\"hive\" block to the linking agent", () => {
    const block = buildBlock("contentA", "alpha");
    const migrated = injectBlock(legacyHiveBlock, block, "alpha");
    expect(hasBlock(migrated, "alpha")).toBe(true);
    expect(hasLegacyBlock(migrated)).toBe(false);
    expect((migrated.match(/obagents:start/g) || []).length).toBe(1);
    expect(migrated).toContain("contentA");
    expect(migrated).not.toContain("legacy hive content");
  });

  it("injectBlock migrates a legacy block without an agent attribute", () => {
    const block = buildBlock("contentA", "alpha");
    const migrated = injectBlock(legacyNoAgentBlock, block, "alpha");
    expect(hasBlock(migrated, "alpha")).toBe(true);
    expect(hasLegacyBlock(migrated)).toBe(false);
    expect(migrated).toContain("contentA");
    expect(migrated).not.toContain("legacy anon content");
  });

  it("removeLegacyBlock removes a legacy block while other live blocks stay", () => {
    const blockB = buildBlock("contentB", "beta");
    const content = `${legacyHiveBlock}\n\n${blockB}\n`;
    expect(hasLegacyBlock(content)).toBe(true);
    expect(hasAgentScopedBlock(content)).toBe(true);
    const removedLegacy = removeLegacyBlock(content);
    expect(hasLegacyBlock(removedLegacy)).toBe(false);
    expect(removedLegacy).toContain("contentB");
    const cleaned = removeLegacyBlock(legacyHiveBlock);
    expect(cleaned.trim()).toBe("");
  });
});
