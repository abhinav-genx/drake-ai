/**
 * Serializes writes to the shared Browserbase Context.
 *
 * Browserbase persists a Context's encrypted user-data-dir when a session ends,
 * and the whole context is a single blob: if two sessions run with
 * `persist: true` at the same time, the last one to close overwrites the other
 * (and sites may force a logout — see the Browserbase "Contexts" docs
 * "Avoid simultaneous logins"). So any sub-agent that needs to WRITE new
 * cookies/localStorage back into the shared context (login / signup) must hold
 * this lock for the whole session, and we wait a moment after it closes so
 * Browserbase can sync before the next reader/writer starts.
 *
 * Read-only sub-agents (persist: false) never take this lock, so they stay
 * fully parallel.
 */

/** Delay after a persisting session closes, so the context finishes syncing. */
const SYNC_DELAY_MS = 4_000;

/**
 * One FIFO queue per user (keyed by their context id). Different users write to
 * different contexts, so they must NOT block each other; only a single user's
 * own login-persisting sub-agents are serialized among themselves.
 */
const chains = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while exclusively holding the write lock for `key` (the user's
 * context id). Calls with the same key are queued FIFO; each runs only after
 * the previous persisting session for that key has closed AND a short sync
 * delay has elapsed. Calls with different keys run concurrently.
 */
export function withContextWriteLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();

  const run = prev.then(async () => {
    try {
      return await fn();
    } finally {
      // Give Browserbase time to flush the persisted context before the next
      // session touches it.
      await sleep(SYNC_DELAY_MS);
    }
  });

  // Keep the chain alive even if this task rejects, so one failure doesn't
  // permanently break the queue. Clean up when this is the tail of the chain.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });

  return run;
}
