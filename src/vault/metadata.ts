import { getAgentDir, getAgentMetaPath } from "../utils/paths.js";
import { fs, writeJsonAtomic } from "../utils/fs.js";
import { normalizeProjectPath } from "./project.js";
import { type SupportedTarget } from "../utils/constants.js";
import { logger } from "../utils/logger.js";
import { withLock, withCrossProcessLock } from "../utils/mutex.js";
import { CorruptStoreError } from "../utils/errors.js";

export type AgentProjectLink = {
  projectDir: string;
  targets: SupportedTarget[];
};

export interface AgentMeta {
  name: string;
  createdAt: string;
  links: AgentProjectLink[];
  consolidationCache?: Record<string, boolean>;
}

async function writeAgentMetaFile(name: string, meta: AgentMeta): Promise<void> {
  await fs.mkdir(getAgentDir(name), { recursive: true });
  await writeJsonAtomic(getAgentMetaPath(name), meta);
}

export function initializeAgentMeta(name: string, meta: AgentMeta): Promise<void> {
  return withLock(getAgentMetaPath(name), () => writeAgentMetaFile(name, meta));
}

export function updateAgentMeta(
  name: string,
  patch: (meta: AgentMeta) => AgentMeta | Promise<AgentMeta>,
): Promise<AgentMeta> {
  return withCrossProcessLock(`${getAgentMetaPath(name)}.lock`, () =>
    withLock(getAgentMetaPath(name), async () => {
      await migrateAgentMeta(name);
      const current = (await getAgentMeta(name)) ?? {
        name,
        createdAt: new Date().toISOString(),
        links: [],
      };
      const next = await patch(current);
      await writeAgentMetaFile(name, next);
      return next;
    }),
  );
}

export async function setCachedConsolidationStatus(
  name: string,
  projectDir: string | undefined,
  needsConsolidation: boolean
): Promise<void> {
  const meta = await getAgentMeta(name);
  if (!meta) return;
  const key = projectDir ? normalizeProjectPath(projectDir) : "__global__";
  meta.consolidationCache = {
    ...(meta.consolidationCache ?? {}),
    [key]: needsConsolidation,
  };
  await initializeAgentMeta(name, meta);
}

function parseProjectsAndTargets(parsed: Record<string, unknown>): { normProjects: string[]; normTargets: SupportedTarget[] } {
  const rawProjects: string[] = Array.isArray(parsed.linkedProjects)
    ? (parsed.linkedProjects as string[])
    : Array.isArray(parsed.projects)
    ? (parsed.projects as string[])
    : [];
  const rawTargets: SupportedTarget[] = Array.isArray(parsed.linkedTargets)
    ? (parsed.linkedTargets as SupportedTarget[])
    : Array.isArray(parsed.targets)
    ? (parsed.targets as SupportedTarget[])
    : [];

  const normProjects = [...new Set(rawProjects.map((p) => normalizeProjectPath(p)))];
  const normTargets = [...new Set(rawTargets)] as SupportedTarget[];

  return { normProjects, normTargets };
}

function parseAgentMeta(name: string, parsed: Record<string, unknown>): AgentMeta {
  const agentName = typeof parsed.name === "string" ? parsed.name : name;
  const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString();
  const consolidationCache =
    parsed.consolidationCache && typeof parsed.consolidationCache === "object"
      ? (parsed.consolidationCache as Record<string, boolean>)
      : undefined;

  if (Array.isArray(parsed.links)) {
    const links: AgentProjectLink[] = parsed.links.map((l: unknown) => {
      const linkObj = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
      return {
        projectDir: normalizeProjectPath(typeof linkObj.projectDir === "string" ? linkObj.projectDir : ""),
        targets: Array.isArray(linkObj.targets)
          ? ([...new Set(linkObj.targets)] as SupportedTarget[])
          : [],
      };
    });
    return { name: agentName, createdAt, links, consolidationCache };
  }

  const { normProjects, normTargets } = parseProjectsAndTargets(parsed);

  const links: AgentProjectLink[] = normProjects.length > 0
    ? normProjects.map((p) => ({ projectDir: p, targets: [...normTargets] }))
    : [];

  return { name: agentName, createdAt, links, consolidationCache };
}

export async function getAgentMeta(name: string): Promise<AgentMeta | null> {
  const path = getAgentMetaPath(name);
  if (!fs.existsSync(path)) {
    return null;
  }
  const raw = await fs.readFile(path, "utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CorruptStoreError("agent metadata", path);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CorruptStoreError("agent metadata", path);
  }
  return parseAgentMeta(name, parsed);
}

export async function migrateAgentMeta(
  name: string,
): Promise<{ meta: AgentMeta | null; warnings: string[] }> {
  const path = getAgentMetaPath(name);
  if (!fs.existsSync(path)) {
    return { meta: null, warnings: [] };
  }
  const raw = await fs.readFile(path, "utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CorruptStoreError("agent metadata", path);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CorruptStoreError("agent metadata", path);
  }

  const isLegacy =
    !Array.isArray(parsed.links) ||
    "linkedTargets" in parsed ||
    "linkedProjects" in parsed;

  const warnings: string[] = [];

  if (isLegacy) {
    const { normProjects, normTargets } = parseProjectsAndTargets(parsed);

    let links: AgentProjectLink[] = [];
    if (normProjects.length > 0) {
      links = normProjects.map((p) => ({ projectDir: p, targets: [...normTargets] }));
    } else if (normTargets.length > 0) {
      const msg = `Discarded stale target(s) [${normTargets.join(", ")}] for agent "${name}" as they had no associated projects.`;
      logger.warning(msg);
      warnings.push(msg);
    }

    const migratedMeta: AgentMeta = {
      name: typeof parsed.name === "string" ? parsed.name : name,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
      links,
    };

    await writeAgentMetaFile(name, migratedMeta);
    return { meta: migratedMeta, warnings };
  }

  const currentMeta = parseAgentMeta(name, parsed);
  return { meta: currentMeta, warnings: [] };
}



