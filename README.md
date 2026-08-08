# OB Agents

**Universal AI agent state synchronizer — one brain, infinite bodies.**

[![CI](https://github.com/abdullah-mhassan/obagents/actions/workflows/ci.yml/badge.svg)](https://github.com/abdullah-mhassan/obagents/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/abdullah-mhassan/obagents)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12.0-brightgreen)](package.json)

OB Agents maintains a single **Vault** for each AI agent's brain — personality, memory, skills — and distributes it to every major AI coding tool. Your AI context stays persistent, synchronized, and accessible whether you're using a GUI tool like Claude Desktop or a CLI/editor tool like Cursor, Aider, or Windsurf.

## Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Tech Stack and Requirements](#tech-stack-and-requirements)
- [CLI Commands](#cli-commands)
- [Available Scripts](#available-scripts)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Features

- **Vault** — centralized storage (`~/.obagents`) for every agent's persona, memory, and skills.
- **Per-project isolation** — each agent's target integrations and working memory are tracked and scoped per project directory.
- **Transactional failure-safety** — link/unlink mutations apply target adapters first with automatic rollback on error, and only commit graph metadata on success.
- **Passive layer** — auto-injects agent state into IDE/CLI config files across a verified 7-target core (`claude-code`, `cursor`, `codex`, `opencode`, `antigravity`, `copilot`, and a passive `AGENT.md` fallback). Passive targets receive the full compiled active-agent state — `SOUL`, project-scoped `MEMORY`, and `USER` context. (Demoted targets like windsurf/roo/kilo remain **unlink-only**: `unlink` can still clean up legacy wiring, but nothing new is ever written for them.)
- **Active layer** — a live, project-aware MCP gateway (`obagents serve`) for dynamic read/write/search by GUI and CLI tools.
- **Hive orchestration** — spawn, link, and consult sub-agents autonomously via project-aware MCP tools. See the [Hive guide](docs/hive.md).
- **Deep memory** — a SQLite FTS5 backend tracking historical tasks, skills, and project-scoped memory consolidation.

## Quick Start

```bash
git clone https://github.com/abdullah-mhassan/obagents.git
cd obagents

pnpm install       # may prompt to approve builds for better-sqlite3 and esbuild
pnpm run build     # compiles TypeScript into dist/
npm link           # exposes `obagents` (alias `ob`) globally
```

- Prefer not to link globally? Run it directly instead: `pnpm tsx src/cli.ts <command>`.
- To remove the global link later: `npm unlink -g obagents`.

## Architecture

OB Agents uses a dual-layer synchronization strategy for maximum compatibility.

<details>
<summary><strong>Directory structure</strong></summary>

```text
OB Agents/
├── src/
│   ├── cli.ts     # Entry point
│   ├── commands/  # CLI subcommands (create, list, link, etc.)
│   ├── vault/     # Agent CRUD, Link Graph, and Core (SOUL, MEMORY, USER)
│   ├── linker/    # Orchestrator for linking to specific tools (7 core / 17-entry catalog)
│   ├── memory/    # SQLite FTS5 initialization and FTS search
│   ├── mcp/       # MCP stdio server setup and tools
│   └── utils/     # Constants, paths, logging, and the FileSystem seam
├── templates/     # Bundled archetypes (engineer, designer, copywriter, orchestrator)
├── tests/         # Vitest unit tests
├── package.json
└── tsup.config.ts
```

</details>

<details>
<summary><strong>Vault structure</strong> (<code>~/.obagents/</code>)</summary>

```text
~/.obagents/
├── config.json                   # Global settings
├── agents.json                   # Central registry (for fast listing)
└── agents/
    └── my-agent/
        ├── agent.json            # Per-agent metadata (per-project link records)
        ├── SOUL.md               # Immutable personality & system prompt
        ├── MEMORY.md             # Vault default working memory
        ├── USER.md               # User preferences
        ├── skills/               # Learned skills (SKILL.md)
        ├── projects/             # Project-scoped working memory
        │   └── <hash>/
        │       ├── project.json  # Project path reference
        │       └── MEMORY.md     # Project-scoped working memory
        └── state.db              # SQLite FTS5 database (history)
```

</details>

## Tech Stack and Requirements

| | |
|---|---|
| Language | TypeScript (Node.js 22.12+) |
| CLI framework | `commander.js` |
| Database | `better-sqlite3` (FTS5) |
| MCP SDK | `@modelcontextprotocol/sdk` (v1) |
| Build | `tsup` |
| Testing | `vitest` |
| Package manager | pnpm (recommended) |

## CLI Commands

| Command | Description |
|---|---|
| `obagents create <name>` | Initialize a new agent in the Vault — `--template <name\|path>` selects a built-in archetype (engineer, designer, copywriter, orchestrator) or a template directory |
| `obagents list` / `ls` | List all agents and their linked targets |
| `obagents link <agent>` | Inject the agent's brain into a tool's config in the current project |
| `obagents unlink <agent>` | Remove the injected config from a target tool |
| `obagents sync [agent]` | Re-link an agent across every project it's registered in |
| `obagents diff` | Show drift between linked files and the freshly compiled state |
| `obagents consolidate <agent>` | Consolidate overflow working memory into long-term storage |
| `obagents serve` | Run the MCP stdio server gateway (Active Layer) |
| `obagents gateway <cmd>` | Manage global MCP registration (`install`, `status`, `uninstall`) |
| `obagents edit <agent> <file>` | Open soul/memory/user in `$EDITOR` |
| `obagents activate <agent>` | Set the active runtime agent for the Hive in a project |
| `obagents delete <agent>` | Delete an agent from the vault entirely |

Every command supports `-h`/`--help`, and the CLI is also exposed under the alias `ob` (e.g. `ob link`, `ob activate`).

**Full flags, options, and target-content-mode details for every command →  [docs/cli-reference.md](docs/cli-reference.md)**

## Available Scripts

| Command | Description |
|---|---|
| `pnpm run build` | Builds the project using `tsup` |
| `pnpm run typecheck` | Type-checks the source with `tsc --noEmit` |
| `pnpm run lint` | Lints the source with `oxlint` |
| `pnpm run check` | Runs lint, typecheck, and tests in sequence |
| `pnpm run test` | Runs the test suite via `vitest` |
| `pnpm run test:watch` | Runs the test suite in watch mode |

## Testing

Testing is done via `vitest`. The suite covers the vault logic, linker mappers, and the MCP tools.

```bash
pnpm run test          # run all tests
pnpm run test:watch    # run tests in watch mode
```

## Troubleshooting

**MCP server connection issues**
Make sure you've run `pnpm run build` so `dist/` exists before setting up your GUI client. The MCP standard expects a built JS entry point, unless you point it at `tsx` directly.

**Missing executable / command not found**
If `obagents` isn't found, make sure you ran `npm link` — or use `pnpm tsx src/cli.ts` during development.

**better-sqlite3 installation failures**
Native extension build failures can happen during `pnpm install`. Make sure Python and C++ build tools are installed for your OS if you hit prebuild or node-gyp errors, and run `pnpm approve-builds` to authorize the install scripts.

**`Module did not self-register` (Node >= 22)**
If commands or tests fail with `Module did not self-register` — or a flood of EACCES / BAD signal errors across many tests — the native module is stale. Run `pnpm rebuild better-sqlite3` first, then retry.

## License

MIT — see [LICENSE](LICENSE).
