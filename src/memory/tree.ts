import type { DatabaseType } from "./db.js";
import { openDatabase } from "./db.js";
import type { Episode } from "./schema.js";
import { projectMatchClause } from "./project-tag.js";

export interface TreeOptions {
  db?: DatabaseType;
  projectDir?: string;
  limitRecentToolCalls?: number;
}

export function generateMemoryTree(
  agentName: string,
  options: TreeOptions = {},
): string {
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase({ agentName });
  const toolCallLimit = options.limitRecentToolCalls ?? 20;

  try {
    const { clause: projectClause, params: projectParams } = projectMatchClause(
      options.projectDir,
    );

    // 1. Skills (Global Scope: listed in every tree regardless of project)
    const skills = db
      .prepare(
        `SELECT * FROM episodes WHERE agent_name = ? AND source = 'skill' ORDER BY id ASC`,
      )
      .all(agentName) as Episode[];

    // 2. Active Knowledge (memory source, excluding superseded entries)
    const activeKnowledge = db
      .prepare(
        `SELECT * FROM episodes
         WHERE agent_name = ? AND source = 'memory' ${projectClause}
           AND id NOT IN (SELECT supersedes FROM episodes WHERE agent_name = ? AND supersedes IS NOT NULL)
         ORDER BY id ASC`,
      )
      .all(agentName, ...projectParams, agentName) as Episode[];

    // 3. Consolidated Milestones
    const consolidations = db
      .prepare(
        `SELECT * FROM episodes WHERE agent_name = ? AND source = 'consolidation' ${projectClause} ORDER BY id ASC`,
      )
      .all(agentName, ...projectParams) as Episode[];

    // 4. Recent Tool Operations
    const toolCalls = db
      .prepare(
        `SELECT * FROM episodes WHERE agent_name = ? AND source IN ('tool-call', 'action') ${projectClause} ORDER BY id DESC LIMIT ?`,
      )
      .all(agentName, ...projectParams, toolCallLimit) as Episode[];

    const lines: string[] = [];
    lines.push(`# Memory Tree: ${agentName}`);
    lines.push("");

    // Section 1: Skills
    lines.push("## 📦 Skills");
    if (skills.length === 0) {
      lines.push("_No skills recorded._");
    } else {
      for (const s of skills) {
        const tagStr = s.tags ? ` [${s.tags}]` : "";
        lines.push(`- **#${s.id}** (${s.created_at})${tagStr}: ${s.content}`);
      }
    }
    lines.push("");

    // Section 2: Active Knowledge
    lines.push("## 🧠 Active Knowledge");
    if (activeKnowledge.length === 0) {
      lines.push("_No active knowledge recorded._");
    } else {
      for (const k of activeKnowledge) {
        const tagStr = k.tags ? ` [${k.tags}]` : "";
        lines.push(`- **#${k.id}** (${k.created_at})${tagStr}: ${k.content}`);
      }
    }
    lines.push("");

    // Section 3: Consolidated Milestones
    lines.push("## 📜 Consolidated Milestones");
    if (consolidations.length === 0) {
      lines.push("_No consolidated milestones recorded._");
    } else {
      for (const c of consolidations) {
        const tagStr = c.tags ? ` [${c.tags}]` : "";
        lines.push(`- **#${c.id}** (${c.created_at})${tagStr}: ${c.content}`);
      }
    }
    lines.push("");

    // Section 4: Recent Tool Operations
    lines.push("## 🛠️ Recent Tool Operations");
    if (toolCalls.length === 0) {
      lines.push("_No recent tool operations recorded._");
    } else {
      for (const t of toolCalls) {
        const tagStr = t.tags ? ` [${t.tags}]` : "";
        lines.push(`- **#${t.id}** (${t.created_at})${tagStr}: ${t.content}`);
      }
    }

    return lines.join("\n");
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}
