import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentDir } from "../utils/paths.js";
import { DB_FILE_NAME, executeSchema } from "./schema.js";

export type { Episode } from "./schema.js";
export type { DatabaseType };

export interface DatabaseOptions {
  agentName: string;
  path?: string;
  inMemory?: boolean;
}

export function openDatabase(options: DatabaseOptions): DatabaseType {
  const dbPath = options.inMemory ? ":memory:" : (options.path ?? getDbPath(options.agentName));
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  applyWalAndSchema(db);
  return db;
}

export function getDbPath(agentName: string): string {
  return `${getAgentDir(agentName)}/${DB_FILE_NAME}`;
}

function applyWalAndSchema(db: DatabaseType): void {
  db.pragma("busy_timeout = 5000");
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    // :memory: databases ignore WAL; safe to skip
  }
  db.pragma("foreign_keys = ON");
  executeSchema(db);
}