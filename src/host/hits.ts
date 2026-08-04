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

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Map searchd hits to palette items; filters non-http(s) and optional same-origin.
 * Label = page title (H1 at index time). Secondary = description/snippet, not chrome.
 */
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
    const title = collapseWs(hit.title ?? "");
    const heading = collapseWs(hit.heading ?? "");
    const snippet = collapseWs(hit.snippet ?? "");

    // Prefer section heading only when it adds info beyond the title.
    let secondary = "";
    if (heading && heading.toLowerCase() !== title.toLowerCase()) {
      secondary = heading;
    } else if (snippet && !snippet.toLowerCase().startsWith(title.toLowerCase())) {
      secondary = snippet;
    } else if (snippet) {
      secondary = snippet;
    } else {
      secondary = path;
    }

    return [{
      id: hit.id,
      collectionId: hit.collectionId,
      kind: "page",
      label: title || path || href,
      title: title || undefined,
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
        title: title || path,
        description: snippet || heading || path,
        url: href,
        kind: "page",
        facts: [
          { label: "URL", value: href },
          ...(heading && heading !== title ? [{ label: "Section", value: heading }] : []),
        ],
      },
    } satisfies SearchItem];
  });
}
