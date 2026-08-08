// End-to-end smoke test for the built OB Agents CLI.
// Runs against an isolated vault: $OBAGENTS_VAULT_DIR if set, otherwise a
// disposable temp dir. Only when explicitly pointed at the real ~/.obagents
// does it back up / restore that vault.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "cli.js");
const realVaultRoot = join(homedir(), ".obagents");
const envVault = process.env.OBAGENTS_VAULT_DIR;
// Only a vault resolving to the real ~/.obagents needs backup/restore; an
// unset var or any other path is a disposable temp vault.
const isRealVault = !!envVault && resolve(envVault) === resolve(realVaultRoot);
const vaultRoot = envVault ? resolve(envVault) : join(tmpdir(), `smoke-vault-${Date.now()}`);
const stamp = `smoke-${Date.now()}`;
const rawBackup = join(tmpdir(), `obagents-backup-${stamp}`);
const rawTemplateDir = join(tmpdir(), `smoke-template-${stamp}`);
const rawProjectDir = join(tmpdir(), `smoke-project-${stamp}`);
// Fake $HOME for every spawned CLI: PathResolver reads os.homedir(), which
// honors $HOME on POSIX, so this keeps target config writes (cursor's
// ~/.cursor/mcp.json, claude's ~/.claude.json, …) out of the real home dir.
// The vault stays controlled by OBAGENTS_VAULT_DIR above.
const smokeHome = join(tmpdir(), `smoke-home-${stamp}`);
let backup = rawBackup;
let templateDir = rawTemplateDir;
let projectDir = rawProjectDir;

let failures = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const fail = (label, err) => {
  failures++;
  console.error(`  ✗ ${label}${err ? `: ${err.message ?? err}` : ""}`);
};
const assert = (cond, label) => (cond ? ok(label) : fail(label, "assertion failed"));

function run(args, cwd = repoRoot, env = {}) {
  const r = spawnSync("node", [cli, ...args], {
    cwd,
    env: { ...process.env, OBAGENTS_VAULT_DIR: vaultRoot, HOME: smokeHome, ...env },
    encoding: "utf8",
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}

console.log(`\nSMOKE TEST — vault ${vaultRoot}`);

try {
  // --- preconditions ---
  if (!existsSync(cli)) {
    throw new Error("dist/cli.js not found — run `pnpm build` first.");
  }

  // --- back up real vault (only when explicitly targeting it) ---
  if (isRealVault) {
    if (existsSync(vaultRoot)) {
      cpSync(vaultRoot, backup, { recursive: true });
      console.log(`  backed up ~/.obagents -> ${backup}`);
    } else {
      console.log("  no existing vault to back up");
    }
    rmSync(vaultRoot, { recursive: true, force: true });
  } else {
    mkdirSync(vaultRoot, { recursive: true });
  }
  mkdirSync(smokeHome, { recursive: true });

  // --- fixtures ---
  mkdirSync(rawTemplateDir, { recursive: true });
  templateDir = realpathSync(rawTemplateDir);
  writeFileSync(join(templateDir, "SOUL.md"), "# Smoke Template Soul\n");
  writeFileSync(join(templateDir, "MEMORY.md"), "# Smoke Template Memory\n");
  writeFileSync(join(templateDir, "USER.md"), "# Smoke Template User\n");
  mkdirSync(rawProjectDir, { recursive: true });
  projectDir = realpathSync(rawProjectDir);

  // --- 1. create ---
  run(["create", "smoke-agent"]);
  assert(existsSync(join(vaultRoot, "agents", "smoke-agent", "SOUL.md")), "create agent");

  // --- 2. create from template ---
  run(["create", "smoke-tpl", "-t", templateDir]);
  const tpl = readFileSync(join(vaultRoot, "agents", "smoke-tpl", "SOUL.md"), "utf8");
  assert(tpl.includes("Smoke Template Soul"), "create agent from template");

  // --- 2b. create from a built-in archetype (bundled templates dir) ---
  run(["create", "smoke-arch", "-t", "engineer"]);
  const archSoul = readFileSync(join(vaultRoot, "agents", "smoke-arch", "SOUL.md"), "utf8");
  assert(archSoul.includes("## Responsibilities"), "create agent from built-in archetype");
  assert(archSoul.includes("<!-- obagents:core-directives v1 -->"), "archetype SOUL has core directives");

  // --- 3. link into a project ---
  run(["link", "smoke-agent", "-t", "cursor"], projectDir);
  assert(existsSync(join(projectDir, ".cursor", "rules", "obagents.mdc")), "link agent to cursor");

  // --- 4. diff --fix reconciles drifted content ---
  writeFileSync(join(projectDir, ".cursor", "rules", "obagents.mdc"), "DRIFTED CONTENT\n");
  const diffOut = run(["diff", "--fix", "-p", projectDir]);
  const relinked = readFileSync(join(projectDir, ".cursor", "rules", "obagents.mdc"), "utf8");
  assert(relinked.includes('agent="smoke-agent"'), "diff --fix re-links drifted target");
  assert(/re-linked|re-link|fixed/i.test(diffOut), "diff --fix reports action");

  // --- 5. sync re-links registered projects ---
  run(["sync", "smoke-agent"]);
  assert(existsSync(join(projectDir, ".cursor", "rules", "obagents.mdc")), "sync agent");

  // --- 6. consolidate archives memory ---
  const beforeMem = readFileSync(join(vaultRoot, "agents", "smoke-agent", "MEMORY.md"), "utf8");
  run(["consolidate", "smoke-agent", "-s", "Smoke test summary."]);
  const afterMem = readFileSync(join(vaultRoot, "agents", "smoke-agent", "MEMORY.md"), "utf8");
  assert(afterMem.includes("Smoke test summary."), "consolidate replaces MEMORY.md");
  assert(afterMem !== beforeMem, "consolidate changed MEMORY.md");
  const epi = join(vaultRoot, "agents", "smoke-agent", "state.db");
  assert(existsSync(epi), "consolidate wrote episode store");

  // --- 7. delete cleans up ---
  run(["delete", "smoke-agent", "-y"]);
  run(["delete", "smoke-tpl", "-y"]);
  run(["delete", "smoke-arch", "-y"]);
  assert(!existsSync(join(vaultRoot, "agents", "smoke-agent")), "delete agent");
  assert(!existsSync(join(vaultRoot, "agents", "smoke-tpl")), "delete template agent");
  assert(!existsSync(join(vaultRoot, "agents", "smoke-arch")), "delete archetype agent");
} catch (err) {
  fail("smoke run aborted", err);
} finally {
  // --- restore real vault (only when it was backed up) ---
  if (isRealVault) {
    rmSync(vaultRoot, { recursive: true, force: true });
    if (existsSync(backup)) {
      cpSync(backup, vaultRoot, { recursive: true });
      rmSync(backup, { recursive: true, force: true });
      console.log("  restored ~/.obagents");
    }
  }
  for (const d of [templateDir, projectDir, smokeHome]) rmSync(d, { recursive: true, force: true });
}

console.log(`\nSMOKE TEST ${failures === 0 ? "PASSED" : `FAILED (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
