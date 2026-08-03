/** Public collection/item contracts for the VM-agnostic palette. */

export type SearchMode = string;

export interface SearchContext {
  query: string;
  mode: SearchMode;
  signal: AbortSignal;
  limit: number;
  /** Optional refinement channel; providers may publish early lexical results. */
  publish?: (items: readonly SearchItem[]) => void;
}

export interface SearchIcon {
  name?: string;
  label?: string;
  text?: string;
}

export interface SearchMatch {
  mode: "lexical" | "semantic" | "hybrid" | "local" | string;
  lexicalRank?: number;
  lexicalScore?: number;
  semanticRank?: number;
  semanticDistance?: number;
  fusedRank?: number;
  explanation?: string;
}

export interface SearchPreview {
  eyebrow?: string;
  identifier?: string;
  title?: string;
  description?: string;
  facts?: readonly { label: string; value: string }[];
  actionLabel?: string;
  url?: string;
  kind?: string;
}

export interface SearchItem {
  id: string;
  collectionId: string;
  kind: string;
  label: string;
  title?: string;
  secondary?: string;
  subtitle?: string;
  keywords?: readonly string[];
  icon?: SearchIcon;
  meta?: string;
  disabled?: boolean;
  score?: number;
  href?: string;
  url?: string;
  payload?: unknown;
  match?: SearchMatch;
  matches?: readonly { start: number; end: number }[];
  preview?: SearchPreview;
}

export interface SearchCollection {
  id: string;
  label: string;
  order?: number;
  icon?: SearchIcon;
  modes?: readonly SearchMode[];
  prefix?: string;
  placeholder?: string;
  emptyStateLabel?: string;
  minQueryLength?: number;
  emptyQuery?: boolean;
  limit?: number;
  source?: "crawl" | "local" | "remote" | string;
  capabilities?: readonly ("lexical" | "semantic" | "hybrid")[];
  items?: readonly SearchItem[];
  search(context: SearchContext): readonly SearchItem[] | Promise<readonly SearchItem[]>;
  select?(detail: SearchSelectionDetail): void | Promise<void>;
}

export interface SearchSelectionDetail {
  item: SearchItem;
  collection: SearchCollection;
  query: string;
  mode: SearchMode;
  method: "keyboard" | "pointer" | "api";
}

export interface CollectionResultState {
  collection: SearchCollection;
  status: "idle" | "loading" | "ready" | "error";
  items: readonly SearchItem[];
  error?: string;
}
