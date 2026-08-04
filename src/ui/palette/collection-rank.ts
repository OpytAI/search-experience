/**
 * Cross-collection presentation order for a non-empty query.
 *
 * Each collection is queried separately; guest RRF scores are rank-only within
 * that list (top hit ≈ 1/(k+1) for every collection). Using only those scores
 * leaves section order stuck on fixed collection.order. We therefore rank
 * sections by how well their best hit matches the query text (title/secondary),
 * with RRF score as a weak tie-break.
 */

import type { CollectionResultState, SearchItem } from "./types.js";

/** Higher = better fit for the typed query (UI presentation only). */
export function itemQueryAffinity(item: SearchItem, query: string): number {
  const q = query.trim().toLowerCase();
  const score = typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0;
  if (!q) return score;

  const label = (item.label || item.title || "").toLowerCase();
  const secondary = (item.secondary || item.subtitle || "").toLowerCase();
  const path = (item.meta || item.href || item.url || "").toLowerCase();

  let boost = 0;
  if (label === q) boost = 1_000_000;
  else if (label.startsWith(`${q} `) || label.startsWith(q)) boost = 500_000;
  else if (label.includes(q)) boost = 100_000;
  else if (secondary.includes(q)) boost = 20_000;
  else if (path.includes(q)) boost = 5_000;

  for (const token of q.split(/\s+/).filter((t) => t.length > 1)) {
    if (label.includes(token)) boost += 2_000;
    else if (secondary.includes(token)) boost += 400;
  }

  // RRF scores are ~0.01; keep them only as fine tie-break within the same boost band.
  return boost + score;
}

export function bestCollectionAffinity(state: CollectionResultState, query: string): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const item of state.items) {
    const a = itemQueryAffinity(item, query);
    if (a > best) best = a;
  }
  if (best === Number.NEGATIVE_INFINITY) {
    // Empty / still loading: keep configured order among empties (sort stable via order).
    return Number.NEGATIVE_INFINITY;
  }
  return best;
}

/**
 * Sort collection sections by best query affinity (desc), then collection.order / label.
 * Does not reorder items within a collection.
 */
export function rankCollectionStatesForQuery(
  states: readonly CollectionResultState[],
  query: string,
): CollectionResultState[] {
  const q = query.trim();
  return [...states].sort((a, b) => {
    const affinityDelta = bestCollectionAffinity(b, q) - bestCollectionAffinity(a, q);
    if (affinityDelta !== 0) return affinityDelta;
    const orderDelta = (a.collection.order ?? 0) - (b.collection.order ?? 0);
    if (orderDelta !== 0) return orderDelta;
    const labelDelta = a.collection.label.localeCompare(b.collection.label);
    if (labelDelta !== 0) return labelDelta;
    return a.collection.id.localeCompare(b.collection.id);
  });
}

/** @deprecated use bestCollectionAffinity — kept name for tests that only pass scores */
export function bestCollectionScore(state: CollectionResultState): number {
  return bestCollectionAffinity(state, "");
}
