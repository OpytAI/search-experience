import type { SearchdResponse } from "../protocol/searchd.js";
import type { SearchItem } from "../search/types.js";
import { sanitizeHttpUrl } from "../security/urls.js";

/** Map searchd hits to palette items; filters non-http(s) and optional same-origin. */
export function hitsToItems(
  hits: NonNullable<Extract<SearchdResponse, { ok: true }>["hits"]>,
  pageOrigin?: string,
): SearchItem[] {
  return (hits ?? []).flatMap((hit) => {
    const href = sanitizeHttpUrl(hit.url) ?? null;
    if (!href) return [];
    if (pageOrigin) {
      try {
        if (new URL(href).origin !== new URL(pageOrigin).origin) return [];
      } catch {
        return [];
      }
    }
    return [{
      id: hit.id,
      collectionId: hit.collectionId,
      kind: "page",
      label: hit.title || href,
      title: hit.title,
      secondary: hit.heading || hit.snippet,
      href,
      url: href,
      score: hit.score,
      match: {
        mode: hit.semanticRank ? "hybrid" : "lexical",
        lexicalRank: hit.lexicalRank,
        semanticRank: hit.semanticRank,
        fusedRank: hit.fusedRank,
      },
      preview: {
        eyebrow: hit.collectionId,
        title: hit.title,
        description: hit.snippet || hit.heading,
        url: href,
        kind: "page",
        facts: [
          { label: "URL", value: href },
          ...(hit.heading ? [{ label: "Section", value: hit.heading }] : []),
        ],
      },
    } satisfies SearchItem];
  });
}
