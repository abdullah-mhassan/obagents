# Mandatory Version Bump & Release Protocol

Whenever updating or bumping the project version number:

1. **Version Bump**: Update `"version"` in `package.json`.
   - **Lockstep**: Bump `VERSION` in `src/utils/constants.ts` to the same value in the same change. The CLI `.version()` output and the MCP handshake read it, so a mismatch makes the shipped CLI report an outdated version and can break version-gated handshakes. Never bump one without the other.
2. **Changelog Sync**: Add release entries under `## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md`.
3. **Verification**: Execute `pnpm check` (or full lint/typecheck/test suite).
4. **Git Commit & Tag**:
   - Commit release changes: `git commit -a -m "chore(release): X.Y.Z"`
   - Create annotated tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`
5. **Remote Push**: Push main branch and tags: `git push origin main --tags`.
6. **GitHub Release**: Publish the GitHub release using:
   `gh release create vX.Y.Z --title "vX.Y.Z" --notes "<changelog notes>"`
