/**
 * Pure path-prefix policy for crawl collections.
 * Mirrors guest/searchd/src/crawl_policy.rs path_allowed / path_starts_with.
 * Used by tests (and available to host tooling that needs the same rules).
 */

/** True when `path` starts with non-empty `prefix`. */
export function pathStartsWith(path: string, prefix: string): boolean {
  if (!prefix) return false;
  return path.startsWith(prefix);
}

/**
 * Whether a URL pathname is allowed for a collection's include/exclude prefixes.
 *
 * 1. Any matching exclude prefix → reject
 * 2. Empty include list → accept
 * 3. Else accept only if some include prefix matches
 */
export function pathAllowed(
  path: string,
  includePathPrefixes: readonly string[] = [],
  excludePathPrefixes: readonly string[] = [],
): boolean {
  if (excludePathPrefixes.some((prefix) => pathStartsWith(path, prefix))) return false;
  if (includePathPrefixes.length === 0) return true;
  return includePathPrefixes.some((prefix) => pathStartsWith(path, prefix));
}

/** Extract pathname from an absolute http(s) URL string (no URL ctor required for guests). */
export function urlPathname(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.pathname || "/";
  } catch {
    return null;
  }
}

/** Origin (scheme://host[:port]) for absolute http(s) URLs. */
export function urlOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Full URL accept rule used by crawl policy: origin membership + path prefixes.
 * When `origins` is empty/undefined, only path rules apply.
 */
export function urlAllowedForCollection(
  url: string,
  options: {
    origins?: ReadonlySet<string> | readonly string[];
    includePathPrefixes?: readonly string[];
    excludePathPrefixes?: readonly string[];
  } = {},
): boolean {
  const path = urlPathname(url);
  if (path == null) return false;
  if (options.origins) {
    const origin = urlOrigin(url);
    if (!origin) return false;
    const set =
      options.origins instanceof Set
        ? options.origins
        : new Set(options.origins);
    if (!set.has(origin)) return false;
  }
  return pathAllowed(
    path,
    options.includePathPrefixes ?? [],
    options.excludePathPrefixes ?? [],
  );
}

/** Default max pages when collection omits maxPages (matches guest crawl_policy). */
export const DEFAULT_MAX_PAGES = 50;
