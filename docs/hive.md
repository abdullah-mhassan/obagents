# Hive Orchestration with OB Agents

Welcome to the Hive Orchestration guide!

OB Agents wasn't just built to manage one agent. It was built to create an ecosystem where AI agents can work together. With the **Active Layer (MCP Server)**, your AI agent can natively spin up, manage, and communicate with other sub-agents. 

This means you can have a "Hive Orchestrator" agent that delegates tasks to specialized sub-agents instead of trying to do everything itself.

## How It Works
When you connect an AI agent (like Claude Desktop, Cursor, or Windsurf) to the OB Agents MCP server using `obagents serve <agent>`, the AI automatically inherits the Hive Orchestration tools. 

These tools interact directly with your Vault (`~/.obagents`), allowing the AI to:
1. **Spawn Specialists:** `create_agent`
2. **Assign Workspaces:** `link_agent`
3. **Check Status/Decisions:** `load_agent_context` & `consult_agent`
4. **Manage Memory Limits:** `consolidate_agent`

## Using the Hive

### 1. Spawning an Orchestrator
To get started, we provide the built-in Orchestrator archetype. Run the following command in your terminal:

```bash
obagents create orchestrator --template orchestrator
```

Now, link this agent to your favorite tool (e.g., Cursor) or start the MCP server:
```bash
obagents serve orchestrator
```

### 2. Conversing with the Orchestrator
Inside your AI chat interface, you can give high-level, complex prompts and rely on the AI to manage the rest.

**Example Prompt:**
> "I need to build a full-stack Next.js app with a PostgreSQL database. Please spawn a `db-expert` sub-agent to handle the schema, and a `frontend-ninja` to handle the React components. Link both of them to this current project."

**Behind the Scenes:**
1. The Orchestrator calls the MCP tool `create_agent` twice (for `db-expert` and `frontend-ninja`).
2. The Orchestrator calls `link_agent` for both, injecting them into your workspace's AI config files.
3. The Orchestrator reports back to you that the team is ready.

### 3. Cross-Agent Collaboration
Agents can read each other's memories! If `db-expert` makes a decision about a database schema, and `frontend-ninja` needs to know what it is:
> "Consult `db-expert`'s memory and find out what schema they used for the users table."

The Orchestrator will use the `consult_agent` MCP tool to query `db-expert`'s SQLite database and retrieve the exact markdown log of the decision.

## MCP Tools Reference
Here are the tools exposed to your AI agent when using Hive Orchestration:

- `create_agent(name, description)`: Initializes a new agent in the Vault.
- `link_agent(name, targets, projectPath)`: Injects an agent's context into a specific project workspace.
- `load_agent_context(targetAgent)`: Dynamically retrieves another agent's rules, persona, and memory.
- `consult_agent(targetAgent, query, limit)`: Queries another agent's memory deterministically to discover their past decisions.
- `consolidate_agent(name, summary)`: Archives an agent's current `MEMORY.md` and replaces it with a shorter summary to save context window space.

## MCP Target Support

Not every supported target consumes the OB Agents MCP server (the Active Layer). A target "uses MCP" if and only if its mapper descriptor declares an `mcp:` block; at `link` / `sync` time that block writes the `obagents serve <agent>` invocation into the target's MCP configuration. Targets without an `mcp:` block use only the Passive Layer (injected instructions or core file paths).

Of the 17 supported targets, **14 consume the MCP server** and **3 do not**.

| Target | Uses MCP? | Config file written | Wiring mechanism |
|--------|-----------|---------------------|------------------|
| cursor | ✅ | `.cursor/mcp.json` | mcpServers |
| windsurf | ✅ | `~/.codeium/windsurf/mcp_config.json` | mcpServers |
| roo | ✅ | `cline_mcp_settings.json` (globalStorage) | mcpServers |
| continue | ✅ | `~/.continue/config.json` | array |
| copilot | ✅ | `.vscode/mcp.json` | servers |
| claude-code | ✅ | `.mcp.json` | mcpServers |
| opencode | ✅ | `opencode.json` | opencode |
| codex | ✅ | `codex mcp add myagent-<agent>` (exec) | CLI |
| kilo | ✅ | `kilo.json` | mcpServers |
| grok | ✅ | `.grok/mcp.json` | mcpServers |
| qwen | ✅ | `.qwen/settings.json` | mcpServers |
| pi | ✅ | `.pi/mcp.json` | mcpServers |
| antigravity | ✅ | `~/.gemini/config/mcp_config.json` | mcpServers |
| command-code | ✅ | `.mcp.json` | mcpServers |
| generic | ❌ | `AGENT.md` | instructions only |
| swe-agent | ❌ | `swe_agent_instructions.md` | instructions only |
| aider | ❌ | `.aider.conf.yml` | core file paths only |

**Notes:**
- `codex` does not write a config file — it registers the server via the `codex mcp add` CLI command at link time and removes it with `codex mcp remove` at clean time.
- `antigravity` writes to a global Gemini config (`~/.gemini/config/mcp_config.json`) rather than a project-local file, but still consumes the MCP server.
- `command-code` shares `<project>/AGENTS.md` (its memory file) with the `antigravity` target and `<project>/.mcp.json` with `claude-code` — agent-scoped marker blocks and the shared `mcpServers` entry shape make both coexist safely; one `.mcp.json` entry serves both `claude-code` and `command-code`.
- `generic` (`AGENT.md`), `swe-agent` (`swe_agent_instructions.md`), and `aider` (`.aider.conf.yml`) rely solely on the Passive Layer — they receive the agent's compiled context but expose no MCP tools.
