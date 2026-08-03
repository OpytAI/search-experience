import type { SearchCollection } from "./types.js";

export interface ParsedSearchInput {
  query: string;
  mode: string;
  modeLabel: string;
  prefix: string;
}

function scopedMode(collection: SearchCollection): string {
  return collection.modes?.[0] ?? collection.id;
}

export function validateCollectionPrefixes(collections: readonly SearchCollection[]): void {
  const claims = new Map<string, { mode: string; id: string }>();
  for (const collection of collections) {
    const prefix = collection.prefix?.normalize("NFKC").toLocaleLowerCase();
    if (!prefix) continue;
    const next = { mode: scopedMode(collection), id: collection.id };
    const current = claims.get(prefix);
    if (current && current.mode !== next.mode) {
      throw new Error(`search prefix ${JSON.stringify(collection.prefix)} conflicts between ${current.id} and ${next.id}`);
    }
    claims.set(prefix, next);
  }
}

export function parseSearchInput(raw: string, collections: readonly SearchCollection[]): ParsedSearchInput {
  const normalized = raw.normalize("NFKC");
  const candidates = collections
    .filter((collection) => collection.prefix)
    .sort((a, b) => b.prefix!.length - a.prefix!.length || a.id.localeCompare(b.id));
  const lowered = normalized.toLocaleLowerCase();
  const collection = candidates.find((candidate) => lowered.startsWith(candidate.prefix!.toLocaleLowerCase()));
  if (!collection) return { query: raw, mode: "", modeLabel: "", prefix: "" };
  return {
    query: normalized.slice(collection.prefix!.length).replace(/^\s+/u, ""),
    mode: scopedMode(collection),
    modeLabel: collection.label,
    prefix: collection.prefix!,
  };
}
