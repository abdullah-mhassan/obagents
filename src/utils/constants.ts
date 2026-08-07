export const VERSION = "0.3.1";

export const VAULT_DIR_NAME = ".obagents";
export const AGENTS_REGISTRY_FILE = "agents.json";
export const AGENTS_DIR_NAME = "agents";
export const AGENT_META_FILE = "agent.json";

export const CORE_FILES = ["SOUL.md", "MEMORY.md", "USER.md"] as const;
export const TRIAD_FILES = CORE_FILES;
export type CoreFile = (typeof CORE_FILES)[number];

export const EDITABLE_FILES = {
  soul: "SOUL.md",
  memory: "MEMORY.md",
  user: "USER.md",
} as const;
export type EditableFileKey = keyof typeof EDITABLE_FILES;

export const REGISTRY_VERSION = 1;

export const NAME_PATTERN = /^[a-z0-9-_]+$/;
export const MAX_AGENTS = 1000;
export const SANITIZE_PATTERN = /[^a-z0-9-_]/g;



export const MEMORY_CHAR_LIMIT = 2500;

export const MEMORY_ENTRY_TYPES = [
  "build-fixed",
  "decision",
  "bug-fixed",
  "milestone",
] as const;
export type MemoryEntryType = (typeof MEMORY_ENTRY_TYPES)[number];

export const STRUCTURED_MEMORY_VERSION = "0.2.1";

export const MAX_UPDATE_STATE_CHARS = 2000;
export const EPISODES_JSONL_FILE_NAME = "episodes.jsonl";
export const TOOL_CALL_ARGS_MAX_CHARS = 200;
export const SKILL_EPISODE_SNIPPET_CHARS = 160;

export const DEFAULT_TOOL_CALL_RETENTION_DAYS = 30;

export const TOOL_CALL_LOG_SKIP = [
  "read_state",
  "search_history",
  "update_state",
  "consult_agent",
  "load_agent_context",
] as const;

export const CONSOLIDATION_TRIGGER_THRESHOLD = 20;

export const CONSOLIDATION_DEDUP_TRIGGER = 3;

export const NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.35;

export const GLOBAL_PROJECT_TAG = "__global__";

export const SUPPORTED_TARGETS = [
  "cursor",
  "windsurf",
  "roo",
  "continue",
  "copilot",
  "claude-code",
  "aider",
  "opencode",
  "codex",
  "kilo",
  "grok",
  "qwen",
  "pi",
  "swe-agent",
  "antigravity",
  "command-code",
  "generic",
] as const;
export type SupportedTarget = (typeof SUPPORTED_TARGETS)[number];

export const CORE_TARGETS = [
  "claude-code",
  "cursor",
  "codex",
  "opencode",
  "antigravity",
  "copilot",
  "generic",
] as const;
export type CoreTarget = (typeof CORE_TARGETS)[number];

export const OBAGENTS_START_PREFIX = "<!-- obagents:start";
export const OBAGENTS_END_MARKER = "<!-- obagents:end -->";

export const GLOBAL_CAPABLE_TARGETS = [
  "claude-code",
  "cursor",
  "windsurf",
  "roo",
  "continue",
  "copilot",
  "opencode",
  "codex",
  "antigravity",
] as const;
export type GlobalCapableTarget = (typeof GLOBAL_CAPABLE_TARGETS)[number];

export const PROJECT_ONLY_TARGETS = [
  "kilo",
  "grok",
  "qwen",
  "pi",
  "command-code",
] as const;
export type ProjectOnlyTarget = (typeof PROJECT_ONLY_TARGETS)[number];

export const PASSIVE_TARGETS = [
  "aider",
  "swe-agent",
  "generic",
] as const;
export type PassiveTarget = (typeof PASSIVE_TARGETS)[number];

export function isGlobalCapableTarget(target: string): boolean {
  return GLOBAL_CAPABLE_TARGETS.includes(target as GlobalCapableTarget);
}

export function isProjectOnlyTarget(target: string): boolean {
  return PROJECT_ONLY_TARGETS.includes(target as ProjectOnlyTarget);
}

export function isPassiveTarget(target: string): boolean {
  return PASSIVE_TARGETS.includes(target as PassiveTarget);
}