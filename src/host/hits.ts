import type { SearchdResponse } from "../protocol/searchd.js";
import type { SearchItem } from "../ui/palette/types.js";
import { sanitizeHttpUrl } from "../security/urls.js";

function pathLabel(href: string): string {
  try {
    const path = new URL(href).pathname;
    return path && path !== "/" ? path : new URL(href).host;
  } catch {
    return href;
  }
}

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
    const path = pathLabel(href);
    const heading = hit.heading?.trim() ?? "";
    const snippet = hit.snippet?.trim() ?? "";
    // Prefer section/snippet; fall back to path so mobile rows stay disambiguated.
    const secondary = heading || snippet || path;
    const description = snippet || heading || path;
    return [{
      id: hit.id,
      collectionId: hit.collectionId,
      kind: "page",
      label: (hit.title?.trim() || path || href),
      title: hit.title,
      secondary,
      meta: secondary === path ? undefined : path,
      href,
      url: href,
      score: hit.score,
      match: {
        mode: hit.matchMode ?? (hit.lexicalRank && hit.semanticRank
          ? "hybrid"
          : hit.semanticRank
            ? "semantic"
            : "lexical"),
        lexicalRank: hit.lexicalRank,
        semanticRank: hit.semanticRank,
        fusedRank: hit.fusedRank,
      },
      preview: {
        eyebrow: hit.collectionId,
        title: hit.title || path,
        description,
        url: href,
        kind: "page",
        facts: [
          { label: "URL", value: href },
          ...(heading ? [{ label: "Section", value: heading }] : []),
        ],
      },
    } satisfies SearchItem];
  });
}
