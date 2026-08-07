import { REGISTRY_VERSION } from "../utils/constants.js";
import { getRegistryPath, getVaultRoot } from "../utils/paths.js";
import { fs } from "../utils/fs.js";
import { withLock, withCrossProcessLock } from "../utils/mutex.js";
import { CorruptStoreError } from "../utils/errors.js";

export interface AgentRegistryEntry {
  createdAt: string;
  targets: string[];
}

export interface AgentsRegistry {
  version: number;
  agents: Record<string, AgentRegistryEntry>;
}

export function emptyRegistry(): AgentsRegistry {
  return { version: REGISTRY_VERSION, agents: {} };
}

export async function readRegistry(): Promise<AgentsRegistry> {
  const path = getRegistryPath();
  if (!fs.existsSync(path)) {
    return emptyRegistry();
  }
  const raw = await fs.readFile(path, "utf8");
  let parsed: Partial<AgentsRegistry>;
  try {
    parsed = JSON.parse(raw) as Partial<AgentsRegistry>;
  } catch {
    throw new CorruptStoreError("registry", path);
  }
  if (!parsed || typeof parsed !== "object" || !parsed.agents) {
    throw new CorruptStoreError("registry", path);
  }
  return {
    version: parsed.version ?? REGISTRY_VERSION,
    agents: parsed.agents as Record<string, AgentRegistryEntry>,
  };
}

export async function writeRegistry(registry: AgentsRegistry): Promise<void> {
  await fs.mkdir(getVaultRoot(), { recursive: true });
  await fs.writeFile(getRegistryPath(), JSON.stringify(registry, null, 2) + "\n", "utf8");
}

export function updateRegistry(
  patch: (registry: AgentsRegistry) => AgentsRegistry | Promise<AgentsRegistry>,
): Promise<AgentsRegistry> {
  return withCrossProcessLock(`${getRegistryPath()}.lock`, () =>
    withLock(getRegistryPath(), async () => {
      const registry = await readRegistry();
      const next = await patch(registry);
      await writeRegistry(next);
      return next;
    }),
  );
}
