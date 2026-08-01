#!/usr/bin/env node
import Database from "better-sqlite3";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function getSnippet(content) {
  if (!content) return "";
  return content.replace(/\s+/g, " ").trim().slice(0, 100);
}

// Parse CLI flags manually
const args = process.argv.slice(2);
let vault = join(homedir(), ".obagents");
const specifiedAgents = [];
let apply = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--vault") {
    if (i + 1 < args.length) {
      vault = args[++i];
    }
  } else if (arg.startsWith("--vault=")) {
    vault = arg.slice("--vault=".length);
  } else if (arg === "--agent") {
    if (i + 1 < args.length) {
      specifiedAgents.push(args[++i]);
    }
  } else if (arg.startsWith("--agent=")) {
    specifiedAgents.push(arg.slice("--agent=".length));
  } else if (arg === "--apply") {
    apply = true;
  }
}

const modeStr = apply ? "APPLY" : "DRY-RUN";
console.log(`Memory Cleanup — Vault: ${vault} [${modeStr}]`);

const agentsDir = join(vault, "agents");
let agentNames = [];

if (specifiedAgents.length > 0) {
  agentNames = specifiedAgents;
} else if (existsSync(agentsDir)) {
  agentNames = readdirSync(agentsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

let totalAgentsProcessed = 0;
let totalDeletedCount = 0;
const allJunkSkills = [];

for (const agentName of agentNames) {
  const agentPath = join(agentsDir, agentName);
  const dbPath = join(agentPath, "state.db");

  if (!existsSync(dbPath)) {
    continue;
  }

  totalAgentsProcessed++;
  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });

  const dupIdsToDelete = new Set();
  const dumpIdsToDelete = new Set();

  try {
    // 1. EXACT DUPLICATES
    const dupGroups = db
      .prepare(
        `SELECT agent_name, source, content, COUNT(*) as cnt
         FROM episodes
         GROUP BY agent_name, source, content
         HAVING cnt > 1`
      )
      .all();

    for (const group of dupGroups) {
      const rows = db
        .prepare(
          `SELECT id FROM episodes
           WHERE agent_name IS ? AND source IS ? AND content IS ?
           ORDER BY id ASC`
        )
        .all(group.agent_name, group.source, group.content);

      const ids = rows.map((r) => r.id);
      const keptId = ids[0];
      const deletedIds = ids.slice(1);

      for (const dId of deletedIds) {
        dupIdsToDelete.add(dId);
      }

      const charCount = (group.content || "").length;
      const snippet = getSnippet(group.content);

      console.log(
        `[DUPLICATE] Agent: ${agentName} | Source: ${group.source} | Chars: ${charCount} | Kept ID: ${keptId} | Deleted IDs: ${deletedIds.join(", ")} | Snippet: ${snippet}`
      );
    }

    // 2. DUMP PURGE
    const skillEpisodes = db
      .prepare(
        `SELECT id, agent_name, source, content, tags
         FROM episodes
         WHERE source = 'skill'`
      )
      .all();

    for (const ep of skillEpisodes) {
      if (dupIdsToDelete.has(ep.id)) {
        continue;
      }
      const contentStr = ep.content || "";
      if (!contentStr.trimStart().startsWith("---")) {
        dumpIdsToDelete.add(ep.id);
        const snippet = getSnippet(contentStr);
        const charCount = contentStr.length;
        console.log(
          `[DUMP] Agent: ${agentName} | ID: ${ep.id} | Tags: ${ep.tags ?? ""} | Chars: ${charCount} | Snippet: ${snippet}`
        );
      }
    }

    // 3. JUNK SKILL FILES
    const skillsDir = join(agentPath, "skills");
    if (existsSync(skillsDir)) {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillName = entry.name;
          const skillFilePath = join(skillsDir, skillName, "SKILL.md");
          if (!existsSync(skillFilePath)) {
            allJunkSkills.push({
              agentName,
              skillName,
              path: skillFilePath,
              reason: "SKILL.md missing",
            });
          } else {
            const skillContent = readFileSync(skillFilePath, "utf8");
            if (!skillContent.trimStart().startsWith("---")) {
              allJunkSkills.push({
                agentName,
                skillName,
                path: skillFilePath,
                reason: "content does not start with '---'",
              });
            }
          }
        }
      }
    }

    // Deletions & Totals
    const countBefore = db.prepare("SELECT COUNT(*) as count FROM episodes").get().count;
    const allIdsToDelete = [...dupIdsToDelete, ...dumpIdsToDelete];
    const dupCount = dupIdsToDelete.size;
    const dumpCount = dumpIdsToDelete.size;

    if (apply) {
      if (allIdsToDelete.length > 0) {
        const deleteStmt = db.prepare("DELETE FROM episodes WHERE id = ?");
        const deleteTx = db.transaction((ids) => {
          for (const id of ids) {
            deleteStmt.run(id);
          }
        });
        deleteTx(allIdsToDelete);
      }
      const countAfter = db.prepare("SELECT COUNT(*) as count FROM episodes").get().count;
      console.log(
        `[TOTALS] Agent: ${agentName} | Duplicates removed: ${dupCount} | Dumps removed: ${dumpCount} | Episodes before: ${countBefore} | Episodes after: ${countAfter}`
      );
    } else {
      const countAfterWouldBe = countBefore - allIdsToDelete.length;
      console.log(
        `[TOTALS] Agent: ${agentName} (DRY-RUN) | Duplicates to remove: ${dupCount} | Dumps to remove: ${dumpCount} | Episodes before: ${countBefore} | Episodes after (would be): ${countAfterWouldBe}`
      );
    }

    totalDeletedCount += allIdsToDelete.length;
  } finally {
    db.close();
  }
}

if (allJunkSkills.length > 0) {
  console.log("\njunk skill file candidates (NOT deleted):");
  for (const item of allJunkSkills) {
    console.log(
      `  - Agent: ${item.agentName} | Skill: ${item.skillName} | Path: ${item.path} (${item.reason})`
    );
  }
}

if (apply) {
  console.log(
    `Summary: mode=APPLY, agents processed: ${totalAgentsProcessed}, total rows deleted: ${totalDeletedCount}`
  );
} else {
  console.log(
    `Summary: mode=DRY-RUN, agents processed: ${totalAgentsProcessed}, total rows would delete: ${totalDeletedCount}`
  );
}
