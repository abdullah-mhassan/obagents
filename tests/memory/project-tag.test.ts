import { describe, it, expect } from "vitest";
import { encodeProjectTag, projectMatchClause } from "../../src/memory/project-tag.js";

describe("encodeProjectTag", () => {
  it("packs type and project into the compound tag format", () => {
    expect(encodeProjectTag("decision", "/projects/alpha")).toBe("decision,/projects/alpha");
  });
});

describe("projectMatchClause", () => {
  it("is a no-op when no project is given", () => {
    expect(projectMatchClause(undefined)).toEqual({ clause: "", params: [] });
  });

  it("matches the bare tags column by default", () => {
    const { clause, params } = projectMatchClause("/projects/alpha");
    expect(clause).toBe("AND (tags = ? OR tags LIKE ? OR tags LIKE ? OR tags LIKE ?)");
    expect(params).toEqual([
      "/projects/alpha",
      "/projects/alpha,%",
      "%,/projects/alpha",
      "%,/projects/alpha,%",
    ]);
  });

  it("qualifies the tags column with the given alias", () => {
    const { clause } = projectMatchClause("/projects/alpha", "e");
    expect(clause).toBe("AND (e.tags = ? OR e.tags LIKE ? OR e.tags LIKE ? OR e.tags LIKE ?)");
  });

  it("includes neutral tags when requested", () => {
    const { clause, params } = projectMatchClause("/projects/alpha", "e", true);
    expect(clause).toContain("e.source = 'skill'");
    expect(clause).toContain("OR e.tags LIKE '%,__global__'");
    expect(clause).toContain("OR (e.tags NOT LIKE '%,/%' AND e.tags NOT LIKE '%,\\%' AND e.tags NOT LIKE '%,_:%')");
    expect(params).toEqual([
      "/projects/alpha",
      "/projects/alpha,%",
      "%,/projects/alpha",
      "%,/projects/alpha,%",
    ]);
  });
});
