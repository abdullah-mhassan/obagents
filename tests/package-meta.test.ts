import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ARCHETYPE_NAMES } from "../src/vault/triad.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("release metadata (publish blockers)", () => {
  it("declares a repository so the package is publishable", async () => {
    const pkg = await readJson(join(root, "package.json"));
    const repository = pkg.repository as { url?: string } | string | undefined;
    const url = typeof repository === "string" ? repository : repository?.url;
    expect(url, "package.json repository.url").toMatch(/github\.com\/abdullah-mhassan\/obagents/);
  });

  it("allows pnpm to build the native better-sqlite3 dependency", async () => {
    const workspace = parseYaml(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")) as {
      onlyBuiltDependencies?: string[];
    };
    const onlyBuiltDependencies = workspace.onlyBuiltDependencies ?? [];
    expect(onlyBuiltDependencies, "pnpm-workspace.yaml onlyBuiltDependencies").toContain("better-sqlite3");
  });

  it("documents the real clone URL in README (no placeholder)", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    expect(readme).toMatch(/git clone https:\/\/github\.com\/abdullah-mhassan\/obagents\.git/);
    expect(readme).not.toMatch(/your-username|YOUR_|changeme|<your/);
  });

  it("ships the templates directory and every archetype in the create help text exists on disk", async () => {
    const pkg = await readJson(join(root, "package.json"));
    const files = (pkg.files as string[]) ?? [];
    expect(files, "package.json files includes templates").toContain("templates");

    const createSrc = await readFile(join(root, "src/commands/create.ts"), "utf8");
    expect(createSrc, "create help text lists archetypes via ARCHETYPE_NAMES").toMatch(
      /built-in archetype name \(\$\{ARCHETYPE_NAMES\.join\(", "\)\}\)/,
    );

    for (const name of ARCHETYPE_NAMES) {
      const dir = join(root, "templates", "archetypes", name);
      const entries = (await readdir(dir)).sort();
      expect(entries, `templates/archetypes/${name}`).toEqual(["MEMORY.md", "SOUL.md", "USER.md"]);
    }
  });
});
