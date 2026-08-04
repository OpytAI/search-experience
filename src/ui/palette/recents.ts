import type { SearchItem } from "./types.js";

export interface RecentEntry {
  key: string;
  lastUsed: number;
  uses: number;
}

export const RECENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const RECENT_STORAGE_LIMIT = 40;

export function recentKey(item: Pick<SearchItem, "collectionId" | "id">): string {
  return `${item.collectionId}\u0000${item.id}`;
}

/**
 * Preserve keyboard/pointer active selection by stable id (collectionId+id)
 * when result lists reorder (e.g. lexical → hybrid refinement). Only fall back
 * to the first enabled item when the previous active id is gone.
 */
export function resolveActiveKey(
  previousKey: string,
  items: readonly SearchItem[],
): string {
  if (previousKey) {
    const stillActive = items.some(
      (item) => !item.disabled && recentKey(item) === previousKey,
    );
    if (stillActive) return previousKey;
  }
  const first = items.find((item) => !item.disabled);
  return first ? recentKey(first) : "";
}

export function pruneRecents(entries: readonly RecentEntry[], now = Date.now()): readonly RecentEntry[] {
  const valid = entries.filter((entry) => (
    typeof entry.key === "string" && entry.key.includes("\u0000")
    && Number.isFinite(entry.lastUsed) && now - entry.lastUsed <= RECENT_MAX_AGE_MS
    && Number.isInteger(entry.uses) && entry.uses > 0
  ));
  return [...new Map(valid.sort((a, b) => b.lastUsed - a.lastUsed).map((entry) => [entry.key, entry])).values()]
    .slice(0, RECENT_STORAGE_LIMIT);
}

export function recordRecent(entries: readonly RecentEntry[], item: SearchItem, now = Date.now()): readonly RecentEntry[] {
  const key = recentKey(item);
  const current = entries.find((entry) => entry.key === key);
  return pruneRecents([
    { key, lastUsed: now, uses: (current?.uses ?? 0) + 1 },
    ...entries.filter((entry) => entry.key !== key),
  ], now);
}

export function deriveLiveRecents(
  entries: readonly RecentEntry[],
  liveItems: readonly SearchItem[],
  limit = 6,
  now = Date.now(),
): readonly SearchItem[] {
  const live = new Map(liveItems.filter((item) => !item.disabled).map((item) => [recentKey(item), item]));
  return pruneRecents(entries, now).flatMap((entry) => live.get(entry.key) ?? []).slice(0, limit);
}
