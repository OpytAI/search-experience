export type {
  CollectionResultState,
  SearchCollection,
  SearchContext,
  SearchIcon,
  SearchItem,
  SearchMatch,
  SearchMode,
  SearchPreview,
  SearchSelectionDetail,
} from "./types.js";
export { SearchCollectionRegistry } from "./registry.js";
export { parseSearchInput, validateCollectionPrefixes } from "./modes.js";
export {
  deriveLiveRecents,
  pruneRecents,
  recentKey,
  recordRecent,
  resolveActiveKey,
  type RecentEntry,
} from "./recents.js";
