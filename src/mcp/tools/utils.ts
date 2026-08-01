import type { DatabaseType } from "../../memory/db.js";
import { MemoryStore } from "../../memory/store.js";
import { agentExists } from "../../vault/agent.js";
import { TOOL_CALL_LOG_SKIP, TOOL_CALL_ARGS_MAX_CHARS, GLOBAL_PROJECT_TAG } from "../../utils/constants.js";
import { encodeProjectTag } from "../../memory/project-tag.js";

export type ToolContent = { type: "text"; text: string };

export function textResult(text: string): { content: ToolContent[] } {
  return { content: [{ type: "text" as const, text }] };
}

export function jsonResult(data: unknown): { content: ToolContent[] } {
  return textResult(JSON.stringify(data));
}

export function errorResult(message: string): { content: ToolContent[]; isError: true } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RegisterToolsOptions {
  db?: DatabaseType;
  store?: MemoryStore;
  projectDir?: string;
}

const SKIP = new Set<string>(TOOL_CALL_LOG_SKIP);

/**
 * Layer-1 capture: record non-self-documenting, state-changing tool calls as
 * `source: "tool-call"` episodes. Filtered and fail-safe.
 */
export function logToolCall(
  store: MemoryStore,
  agentName: string,
  toolName: string,
  args: unknown,
  outcome: string,
  projectDir?: string,
): void {
  if (SKIP.has(toolName)) return;
  try {
    const argsJson = JSON.stringify(args ?? {});
    const truncated =
      argsJson.length > TOOL_CALL_ARGS_MAX_CHARS
        ? argsJson.slice(0, TOOL_CALL_ARGS_MAX_CHARS) + "…"
        : argsJson;
    const project = projectDir ?? GLOBAL_PROJECT_TAG;
    store.addEpisode({
      source: "tool-call",
      content: `tool=${toolName} args=${truncated} outcome=${outcome}`,
      tags: encodeProjectTag("tool-call", project),
    });
  } catch {
    // Capture must never break the tool it observes.
  }
}

export function withAgentContext<T>(
  agentName: string,
  toolName: string,
  options: RegisterToolsOptions,
  handler: (args: T, store: MemoryStore, servedProject?: string) => Promise<unknown>
): (args: T) => Promise<{ content: ToolContent[]; isError?: true }> {
  return async (args: T) => {
    try {
      if (!agentExists(agentName)) {
        return errorResult(`Agent "${agentName}" does not exist.`);
      }

      const store = options.store ?? new MemoryStore(agentName, options.db ? { db: options.db } : undefined);
      try {
        const result = await handler(args, store, options.projectDir);
        logToolCall(store, agentName, toolName, args, "ok", options.projectDir);
        return jsonResult(result);
      } catch (inner) {
        logToolCall(store, agentName, toolName, args, `error: ${messageOf(inner)}`, options.projectDir);
        throw inner;
      } finally {
        if (!options.store) store.close();
      }
    } catch (error) {
      return errorResult(messageOf(error));
    }
  };
}
