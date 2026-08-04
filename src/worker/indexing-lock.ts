/**
 * Cross-tab exclusive ownership for index mutation.
 *
 * Multi-tab contract (Web Locks name: agentos-search-index):
 * - The leader holds the exclusive lock for the full mutation path:
 *   driveCrawl / driveEmbed / handleRefresh (and guest promote that runs when
 *   a candidate crawl completes). Readers never take this lock.
 * - Query, status, and diagnostics stay lock-free so tabs can serve a stable
 *   active generation while another tab rebuilds a candidate.
 * - In-tab single-flight is layered on top so concurrent refresh/init work
 *   collapses; the exclusive lock prevents two tabs from promoting candidate.db
 *   into index.db at the same time (double-promote races).
 */

export const INDEX_LOCK_NAME = "agentos-search-index";

type LockRequest = (
  name: string,
  options: { mode: "exclusive" },
  callback: () => Promise<void>,
) => Promise<void>;

function getLocksRequest(): LockRequest | undefined {
  const locks = (globalThis as unknown as {
    navigator?: { locks?: { request: LockRequest } };
  }).navigator?.locks;
  return locks?.request?.bind(locks);
}

/**
 * Run index-mutation work under the cross-tab exclusive lock when available.
 * `start` must implement in-tab single-flight (e.g. shared pending promise).
 */
export async function withIndexLock(start: () => Promise<void>): Promise<void> {
  const request = getLocksRequest();
  if (request) {
    await request(INDEX_LOCK_NAME, { mode: "exclusive" }, () => start());
    return;
  }
  await start();
}

/** True when navigator.locks is available (unit-testable via injection). */
export function indexLockAvailable(
  locks: { request?: unknown } | undefined | null = (globalThis as unknown as {
    navigator?: { locks?: { request?: unknown } };
  }).navigator?.locks,
): boolean {
  return typeof locks?.request === "function";
}
