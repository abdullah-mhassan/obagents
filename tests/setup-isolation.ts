import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { pathResolver } from "../src/utils/paths.js";

// Every test suite MUST assume a virtual home directory (the one created
// below), never the real user's HOME (~/.cursor, ~/.claude.json,
// ~/.config/Code, etc.). Any test that reads or writes config paths must do so
// inside this disposable temp home. Because getVaultRoot() falls back to
// getHomeDir() for the vault location, isolating home also keeps the vault
// (and any suite that does not set its own overrideVaultRoot()) sandboxed.
const isolated = mkdtempSync(join(tmpdir(), "obagents-test-home-"));

pathResolver.setHomeDir(isolated);

afterAll(() => {
  // Guard: catch suites that point the resolver at a real (non-temp) home and
  // leave it set. After reset() home falls back to the OS default — that is a
  // clean cleanup and is allowed (the suite ran inside its own override during
  // the tests, never at the real home). Only an ACTIVE override to some path
  // other than the isolated temp home is a violation.
  const current = pathResolver.getHomeDir();
  const isActiveOverride = current !== homedir();
  if (isActiveOverride && current !== isolated) {
    throw new Error(
      "Test isolation violated: home dir was pointed off the isolated temp home.",
    );
  }
  pathResolver.reset();
});