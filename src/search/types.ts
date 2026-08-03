/** Public search item and collection types. */

export interface SearchMatch {
  start: number;
  end: number;
}

export interface SearchPreview {
  title: string;
  description?: string;
  url?: string;
  kind?: string;
}

export interface SearchItem {
  id: string;
  collectionId: string;
  title: string;
  subtitle?: string;
  url?: string;
  score?: number;
  matches?: readonly SearchMatch[];
  preview?: SearchPreview;
}

export interface SearchCollection {
  id: string;
  label: string;
  order?: number;
  items: readonly SearchItem[];
}

export interface SearchContext {
  query: string;
  path?: string;
}

export interface SearchSelectionDetail {
  item: SearchItem;
  collection: SearchCollection;
  query: string;
}
