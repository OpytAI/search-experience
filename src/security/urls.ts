/** Shared URL safety helpers for navigation, extract, and fetch policy. */

export function isHttpOrHttpsUrl(value: string, base?: string): boolean {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Safe navigation targets: http(s) and optionally restricted to one origin. */
export function sanitizeNavigationUrl(
  value: string | undefined | null,
  pageOrigin?: string,
): string | null {
  if (!value || typeof value !== "string") return null;
  try {
    const url = pageOrigin ? new URL(value, pageOrigin) : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (pageOrigin) {
      const origin = new URL(pageOrigin).origin;
      if (url.origin !== origin) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function sanitizeHttpUrl(value: string, base?: string): string | null {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Strict same-origin (scheme + host + port). Used for crawl allowlist expansion.
 * Cross-scheme/port hosts are not treated as equivalent.
 */
export function isSameOrigin(candidate: string, pageOrigin: string): boolean {
  try {
    const a = new URL(candidate);
    const b = new URL(pageOrigin);
    if (a.protocol !== "http:" && a.protocol !== "https:") return false;
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

/** @deprecated Prefer isSameOrigin for crawl policy. */
export function isSameSiteOrigin(candidate: string, pageOrigin: string): boolean {
  return isSameOrigin(candidate, pageOrigin);
}
