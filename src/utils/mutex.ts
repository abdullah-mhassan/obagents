const chains = new Map<string, Promise<unknown>>();

/**
 * Serialize jobs per key through a promise chain. `fn` runs only after every
 * previously queued job for the same key has settled, so read-modify-write
 * cycles keyed by the same path cannot interleave. Errors propagate to the
 * caller while the chain itself stays alive for subsequent jobs.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  chains.set(key, result.then(() => undefined, () => undefined));
  return result;
}
