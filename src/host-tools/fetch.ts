import type { SearchFetchInput, SearchFetchOutput } from "../protocol/host-tools.js";
import { isHttpOrHttpsUrl } from "../security/urls.js";

export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "[::1]" || h === "::1") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

export interface FetchToolOptions {
  /** Allowed origins for crawl fetches (same-origin by default). */
  allowedOrigins: ReadonlySet<string>;
  /**
   * When false (default), private/link-local hosts are rejected unless that
   * exact origin is already in allowedOrigins (same-origin localhost demos).
   */
  allowPrivateAddresses?: boolean;
}

/** Fixed visitor product UA — guest-supplied User-Agent is ignored. */
export const SEARCH_FETCH_USER_AGENT = "AgentOSSearch/1.0";

function assertAllowedUrl(url: URL, options: FetchToolOptions, label: string): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported ${label} protocol`);
  }
  if (!options.allowedOrigins.has(url.origin)) {
    throw new Error(`${label} origin not allowed`);
  }
  // Private hosts require either allowPrivateAddresses or an explicit origin allowlist entry.
  if (
    options.allowPrivateAddresses !== true &&
    isPrivateHostname(url.hostname) &&
    !options.allowedOrigins.has(url.origin)
  ) {
    throw new Error("private host blocked");
  }
}

/**
 * Bounded same-origin fetch. No credentials.
 * Rejects off-origin redirects via finalUrl origin check.
 */
export async function runSearchFetch(
  input: SearchFetchInput,
  options: FetchToolOptions,
): Promise<SearchFetchOutput> {
  const maxBytes = Math.max(1_024, Math.min(input.maxBytes ?? 2_000_000, 8_000_000));
  const timeoutMs = Math.max(500, Math.min(input.timeoutMs ?? 15_000, 60_000));
  // Ignore guest-supplied userAgent for the visitor product path.
  const userAgent = SEARCH_FETCH_USER_AGENT;

  if (!isHttpOrHttpsUrl(input.url)) {
    throw new Error("invalid fetch url");
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("invalid fetch url");
  }
  assertAllowedUrl(url, options, "fetch");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.href, {
      method: "GET",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": userAgent,
      },
    });

    let finalUrl: URL;
    try {
      finalUrl = new URL(response.url || url.href);
    } catch {
      throw new Error("invalid final url");
    }
    assertAllowedUrl(finalUrl, options, "finalUrl");

    const contentType = response.headers.get("content-type") ?? "";
    const buffer = new Uint8Array(await response.arrayBuffer());
    const truncated = buffer.byteLength > maxBytes;
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    const body = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    return {
      url: url.href,
      finalUrl: finalUrl.href,
      status: response.status,
      contentType,
      body,
      truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}
