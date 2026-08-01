/**
 * A persistent store failed to parse. The message names the offending file so
 * the CLI error shell renders an actionable instruction; no write path may
 * overwrite a store whose read failed this way.
 */
export class CorruptStoreError extends Error {
  constructor(store: string, filePath: string) {
    super(`Corrupt ${store} at ${filePath}. Move it aside and retry.`);
    this.name = "CorruptStoreError";
  }
}
