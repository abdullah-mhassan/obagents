export {
  CORE_FILES,
  TRIAD_FILES,
  ARCHETYPE_NAMES,
  resolveTemplateDir,
  CORE_DIRECTIVES_VERSION,
  buildCoreDirectivesBlock,
  coreDirectivesVersionIn,
  ensureCoreDirectives,
  DEFAULT_SOUL_TEMPLATE,
  DEFAULT_MEMORY_TEMPLATE,
  DEFAULT_USER_TEMPLATE,
  isDefaultUserContext,
  writeCoreTo,
} from "./compiler.js";

export type { CoreFile, ArchetypeName } from "./compiler.js";
