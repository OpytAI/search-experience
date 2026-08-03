/** Protocol and format versions. Bump only with coordinated host + guest + manifest changes. */

export const SEARCH_PROTOCOL_VERSION = 1 as const;
export const SEARCHD_PROTOCOL_VERSION = 1 as const;
export const SNAPSHOT_FORMAT_VERSION = 1 as const;
export const MANIFEST_SCHEMA_VERSION = 1 as const;

/** Service name registered with AgentOS `/svc/*` (stamped mc_service or guest authority path). */
export const SEARCHD_SERVICE_NAME = "searchd" as const;

/** Host tool catalog addresses (four-segment AgentOS form). */
export const HOST_TOOL_ADDRESSES = {
  fetch: "host.org.main.search.fetch",
  extract: "host.org.main.search.extract",
  embedBatch: "host.org.main.search.embed.batch",
} as const;

/** Host tool binding names (router keys). */
export const HOST_TOOL_NAMES = {
  fetch: "search fetch",
  extract: "search extract",
  embedBatch: "search embed batch",
} as const;
