# CLI Reference

Full command-by-command reference for the `obagents` CLI (alias `ob`). For a quick overview, see the [command table in the README](../README.md#cli-commands).

You can always append `-h` or `--help` to any command to see its description and available options:

```bash
obagents --help
obagents link --help
```

## Agent Lifecycle

### `obagents create <name>`

Initialize a new agent in the Vault.

- `-f, --force`: Overwrite the agent if it already exists.
- `-t, --template <name|path>`: Create the agent from a built-in archetype (`engineer`, `designer`, `copywriter`, `orchestrator`) or a template directory containing `SOUL.md`, `MEMORY.md`, and `USER.md`.
- `-d, --description <text>`: One-line description substituted into `{{AGENT_DESCRIPTION}}` placeholders. Without it, the CLI prompts only when the name argument is omitted; passing a name skips the prompt.

### `obagents list` (or `ls`)

List all agents in the vault. Shows names, creation dates, and per-project linked targets.

### `obagents edit <agent> <file>`

Open one of the agent's files (`soul`, `memory`, `user`) in `$EDITOR`.

### `obagents delete <agent>`

Delete an agent from the vault entirely. Resolves all project/target associations, outputs a cleanup plan, removes target integrations across all linked projects first, and deletes vault data last (failing closed on error).

- `-y, --yes`: Bypass interactive confirmation prompt.

### `obagents activate <agent>`

Set the active runtime agent for the Hive in the current project. Rewrites the compiled team roster into every target the agent is linked to in the project.

- `-p, --project <path>`: Path to the project (default: current directory). If no agent is provided, an interactive selector is shown.

## Linking and Sync

### `obagents link <agent>`

Inject the compiled agent brain into the target tool's configuration in the current directory with transactional failure-safety.

- `-t, --target <tool>`: Specific tool to target. Supported targets (the verified core set): `claude-code`, `cursor`, `codex`, `opencode`, `antigravity`, `copilot`, `generic`. Demoted/legacy targets (e.g. `windsurf`, `roo`, `continue`, `kilo`, `grok`, `qwen`, `pi`, `swe-agent`, `aider`, `command-code`) can no longer be linked — they remain available to `unlink` only, for cleaning up old wiring.
- `--dry-run`: Show what would be written without making changes. Enforces a hard no-write contract across graph updates, target files, global settings, MCP registrations, and external CLI hooks.
- `-f, --force`: Overwrite conflicting non-OB Agents content.
- `--replace`: Replace the existing target set instead of unioning new targets into it (default link is additive).

> **Target Content Modes & MCP Naming**
> - **MCP Targets:** MCP-capable core targets (`cursor`, `copilot`, `claude-code`, `opencode`, `codex`, `antigravity`) receive the compact Hive roster and register the single `obagents` global gateway MCP server.
> - **Passive Target:** `generic` (no MCP) receives the compact Hive roster PLUS the active agent's compiled `SOUL.md`, project-scoped `MEMORY.md`, and `USER.md` content injected into `AGENT.md`.
> - **Fail-loud wiring:** if a target's MCP registration fails (e.g. the Codex CLI rejects the registration), `link` exits non-zero instead of printing a warning and claiming success.

### `obagents unlink <agent>`

Remove the injected OB Agents configuration from the target tool.

- `-t, --target <tool>`: Specific tool to unlink.
- `--all`: Unlink from every target this agent is currently linked to in the current project.
- `--dry-run`: Show what would be unlinked without making changes.

### `obagents sync [agent]`

Re-link an agent into every project registered in its `links`, across all of its project-specific target sets. Use this after changing the agent's brain to push updates everywhere at once.

- `--dry-run`: Show what would be written without making changes. Enforces a hard no-write contract.

### `obagents diff`

Show drift between the linked project files and the freshly compiled agent state. Scopes inspection strictly to targets registered for the active agent in the project in the link graph, validating both markdown context blocks and MCP server registrations. Reports each as **in sync**, **drifted** (with unified diff), or **missing**. Exits non-zero when anything is out of sync.

- `-p, --project <path>`: Project directory to inspect (default: current directory).
- `--fix`: Re-link any drifted or missing targets to bring them back in sync.

## Memory

### `obagents consolidate <agent>`

Consolidate overflow working memory into long-term storage/summary.

- `--summary <text>`: Summary text (optional, prompts interactively if omitted).

## MCP Server & Gateway

### `obagents serve`

Run the MCP Hive gateway (Active Layer) for a project or environment. Provides dynamic per-call project and agent context resolution across all tools (`load_agent_context`, `consult_agent`, `update_state`, etc.).

- `-p, --project <path>`: Project directory to resolve the Hive from (default: current directory).

### `obagents gateway install`

Ensure user-level (global) MCP entries for the `obagents` gateway across all core global-capable tools (cursor, copilot, claude-code, opencode, codex, antigravity). Automatically cleans up stale per-agent entries.

- `--dry-run`: Show what would be installed without making changes.

### `obagents gateway status`

List registration status of the `obagents` gateway across supported tools (global or project scope).

- `-p, --project <path>`: Project directory to inspect for project-only tools.

### `obagents gateway uninstall`

Remove user-level (global) MCP entries for the `obagents` gateway across all core global-capable tools.

- `--dry-run`: Show what would be uninstalled without making changes.

---

The CLI is also exposed under the alias `ob` (e.g. `ob link`, `ob activate`).
