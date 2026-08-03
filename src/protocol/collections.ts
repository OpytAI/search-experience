/** Collection configuration shared by integrator config, manifest, and searchd. */

export interface BrowserCrawlDefinition {
  id: string;
  label: string;
  seeds: readonly string[];
  origins?: readonly string[];
  includePathPrefixes?: readonly string[];
  excludePathPrefixes?: readonly string[];
  language?: string;
  order?: number;
  minQueryLength?: number;
  limit?: number;
  prefix?: string;
  placeholder?: string;
  emptyStateLabel?: string;
  maxPages?: number;
  maxQueue?: number;
  maxPageBytes?: number;
  maxSitemaps?: number;
  timeoutMs?: number;
}

export interface CrawlCollectionDescriptor {
  id: string;
  label: string;
  order?: number;
  minQueryLength?: number;
  limit?: number;
  prefix?: string;
  placeholder?: string;
  emptyStateLabel?: string;
  language?: string;
  builtAt?: string;
  truncated?: boolean;
  capabilities: readonly ("lexical" | "semantic" | "hybrid")[];
  pages?: number;
  chunks?: number;
}
