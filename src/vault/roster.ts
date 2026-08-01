import { getAgentMeta } from "./metadata.js";

export const HIVE_PROTOCOL_SECTION = `## Hive Protocol

- For another agent’s knowledge, use \`consult_agent\` for a focused question or
  \`load_agent_context\` for its full context.
- If consultation is sparse, report that result and get approval before expensive
  exploration or delegation.
- Delegate only bounded tasks with a clear owner and expected outcome.
- Reuse a teammate’s recorded findings; do not repeat completed investigation.`;

export async function compileRoster(
  projectDir: string,
  rosterAgents: string[] = [],
  activeAgent?: string,
  extraAgents: string[] = [],
): Promise<string> {
  const allAgents = Array.from(new Set([...rosterAgents, ...extraAgents]));
  const effectiveActive = activeAgent ?? (allAgents.length > 0 ? allAgents[0] : undefined);
  
  let roster = `# 🛡️ OB Agents Hive\n\n`;
  roster += `You are operating in a multi-agent environment managed by the OB Agents CLI.\n`;
  roster += `Instead of loading massive system prompts directly, you are the Orchestrator.\n`;
  roster += `If the user @mentions a specific agent, or asks for help from a specific agent, you MUST use the \`load_agent_context\` MCP tool to dynamically retrieve their rules, persona, and memory before responding. Pass the agent name WITHOUT the leading '@' (e.g. targetAgent: "odba").\n\n`;
  
  if (effectiveActive) {
    roster += `**Active Runtime Agent:** @${effectiveActive}\n`;
    roster += `*(If no other agent is mentioned, you should assume the persona and rules of the Active Runtime Agent by loading their context immediately.)*\n\n`;
  } else {
    roster += `**Active Runtime Agent:** None set. (Act as a neutral orchestrator unless instructed otherwise).\n\n`;
  }

  roster += `**Available Hive Members:**\n`;
  if (allAgents.length === 0) {
    roster += `- No agents currently linked to this project.\n`;
  } else {
    for (const agent of allAgents) {
      const meta = await getAgentMeta(agent);
      const dateStr = meta?.createdAt ? ` (Linked/Created: ${new Date(meta.createdAt).toISOString().split('T')[0]})` : '';
      roster += `- @${agent}${dateStr}\n`;
    }
  }

  roster += `\n${HIVE_PROTOCOL_SECTION}`;

  return roster;
}

