import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { SearchCollectionRegistry } from "../search/registry.js";
import { parseSearchInput } from "../search/modes.js";
import { deriveLiveRecents, pruneRecents, recordRecent, type RecentEntry } from "../search/recents.js";
import type {
  CollectionResultState,
  SearchCollection,
  SearchItem,
  SearchSelectionDetail,
} from "../search/types.js";
import { sanitizeNavigationUrl } from "../security/urls.js";

const optionKey = (item: SearchItem) => `${item.collectionId}\u0000${item.id}`;
const RECENT_STORAGE_KEY = "agentos-search:recents:v1";

function printableIcon(item: SearchItem): string {
  return item.icon?.text || item.icon?.label?.slice(0, 1) || (item.kind === "page" ? "↗" : "•");
}

export class McSiteSearch extends LitElement {
  static styles = css`
    :host {
      box-sizing: border-box;
      color: var(--mc-search-fg, var(--fg, #17171a));
      font-family: var(
        --mc-search-font,
        var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif)
      );
      -webkit-font-smoothing: antialiased;
    }
    :host([hidden]) { display: none; }
    *, *::before, *::after { box-sizing: border-box; }
    .launcher {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      min-height: 36px;
      padding: 0 11px;
      color: var(--mc-search-fg-secondary, var(--fg-muted, #62626b));
      font: inherit;
      font-size: 13px;
      background: var(--mc-search-surface, var(--surface-2, #fff));
      border: 1px solid var(--mc-search-border, var(--border, #dedee5));
      border-radius: var(--mc-search-row-radius, var(--radius-button, 8px));
      box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
      cursor: pointer;
    }
    .launcher:hover { color: var(--mc-search-fg, var(--fg, #17171a)); }
    .launcher:focus-visible, button:focus-visible {
      outline: 2px solid var(--mc-search-focus, var(--accent, #5865f2));
      outline-offset: 2px;
    }
    kbd {
      padding: 2px 5px;
      color: var(--mc-search-fg-subtle, var(--fg-subtle, #777781));
      font: 600 10px/1.25 var(--mc-search-font-mono, var(--font-mono, ui-monospace, monospace));
      background: var(--mc-search-elevated, var(--surface-3, #f2f2f5));
      border: 1px solid var(--mc-search-border, var(--border, #dedee5));
      border-radius: 5px;
    }
    dialog {
      width: min(var(--mc-search-width, 880px), calc(100vw - 32px));
      max-width: none;
      max-height: min(var(--mc-search-max-height, 560px), calc(100dvh - 24px));
      margin: var(--mc-search-top, 9vh) auto auto;
      padding: 0;
      overflow: hidden;
      color: inherit;
      background: var(--mc-search-surface, var(--surface-2, #fff));
      border: 1px solid var(--mc-search-border, var(--border, #d8d8df));
      border-radius: var(--mc-search-radius, var(--radius-card, 18px));
      box-shadow: var(--mc-search-shadow, 0 28px 90px rgb(0 0 0 / 28%), 0 2px 8px rgb(0 0 0 / 10%));
    }
    dialog::backdrop {
      background: var(--mc-search-backdrop, rgb(8 8 12 / 52%));
      backdrop-filter: blur(var(--mc-search-backdrop-blur, 3px));
    }
    .input-row {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 66px;
      padding: 0 20px;
      background: var(--mc-search-header-bg, transparent);
      border-bottom: 1px solid var(--mc-search-border, var(--border, #dedee5));
      transition: background-color 140ms ease, border-color 140ms ease;
    }
    .input-row:focus-within {
      background: var(--mc-search-focus-bg, color-mix(in srgb, var(--mc-search-focus, var(--accent, #5865f2)) 4%, transparent));
      border-bottom-color: var(--mc-search-focus-border, color-mix(in srgb, var(--mc-search-focus, var(--accent, #5865f2)) 38%, var(--mc-search-border, #dedee5)));
    }
    .search-icon {
      display: grid;
      flex: 0 0 22px;
      width: 22px;
      height: 22px;
      place-items: center;
      color: var(--mc-search-fg-subtle, var(--fg-subtle, #777781));
      transition: color 140ms ease, transform 140ms ease;
    }
    .search-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.8; }
    .input-row:focus-within .search-icon { color: var(--mc-search-focus, var(--accent, #5865f2)); transform: scale(1.04); }
    .mode-chip {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 0 8px;
      color: var(--mc-search-active-fg, var(--mc-search-fg, #17171a));
      font-size: 11px;
      font-weight: 700;
      background: var(--mc-search-active-bg, var(--surface-3, #f0f0f4));
      border-radius: 7px;
      white-space: nowrap;
    }
    input {
      width: 100%;
      min-width: 0;
      padding: 16px 0;
      color: var(--mc-search-fg, var(--fg, #17171a));
      font: inherit;
      font-size: 16px;
      font-weight: 500;
      line-height: 1.35;
      background: transparent;
      border: 0;
      outline: 0;
    }
    input:focus-visible { outline: none; }
    input::placeholder { color: var(--mc-search-fg-subtle, var(--fg-subtle, #8a8a93)); }
    .body { display: grid; grid-template-columns: minmax(0, 1fr) var(--mc-search-preview-width, 300px); min-height: 320px; }
    .list {
      max-height: calc(min(var(--mc-search-max-height, 560px), calc(100dvh - 24px)) - 104px);
      padding: 8px;
      overflow: auto;
      overscroll-behavior: contain;
      scrollbar-color: var(--mc-search-scrollbar, #b7b7c0) transparent;
      scrollbar-width: thin;
    }
    .collection + .collection { margin-top: 5px; }
    .collection-heading {
      position: sticky;
      top: -8px;
      z-index: 1;
      display: flex;
      justify-content: space-between;
      padding: 9px 9px 6px;
      color: var(--mc-search-fg-subtle, var(--fg-subtle, #777781));
      font-size: 10px;
      font-weight: 750;
      letter-spacing: .085em;
      text-transform: uppercase;
      background: var(--mc-search-surface, var(--surface-2, #fff));
    }
    .option {
      display: grid;
      grid-template-columns: 25px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: var(--mc-search-row-height, 42px);
      padding: 6px 9px;
      color: inherit;
      text-align: left;
      font: inherit;
      background: transparent;
      border: 0;
      border-radius: var(--mc-search-row-radius, var(--radius-button, 8px));
      cursor: pointer;
    }
    .option[data-active="true"] {
      color: var(--mc-search-active-fg, var(--mc-search-fg, var(--fg, #17171a)));
      background: var(--mc-search-active-bg, var(--surface-3, #f0f0f4));
    }
    .option:focus-visible { outline-offset: -2px; }
    .option[aria-disabled="true"] { opacity: .52; cursor: not-allowed; }
    .option-icon {
      display: grid;
      width: var(--mc-search-icon-size, 18px);
      height: var(--mc-search-icon-size, 18px);
      place-items: center;
      color: var(--mc-search-fg-secondary, var(--fg-muted, #62626b));
      font-size: 13px;
    }
    .option-copy { min-width: 0; }
    .option-label { display: block; overflow: hidden; font-size: 13px; font-weight: 620; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
    .option-secondary { display: block; margin-top: 2px; overflow: hidden; color: var(--mc-search-fg-secondary, var(--fg-muted, #696972)); font-size: 11px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
    .option-meta { color: var(--mc-search-fg-subtle, var(--fg-subtle, #777781)); font: 500 10px/1.2 var(--mc-search-font-mono, var(--font-mono, ui-monospace, monospace)); }
    .preview {
      position: relative;
      padding: 26px;
      overflow: auto;
      color: var(--mc-search-fg-secondary, var(--fg-muted, #62626b));
      background: var(--mc-search-substrate, var(--surface-1, #f7f7f9));
      border-left: 1px solid var(--mc-search-border, var(--border, #dedee5));
    }
    .preview::after {
      position: absolute;
      right: -48px;
      bottom: -58px;
      width: 150px;
      height: 150px;
      background: radial-gradient(circle, var(--mc-search-preview-glow, color-mix(in srgb, var(--mc-search-focus, #5865f2) 12%, transparent)), transparent 68%);
      border-radius: 50%;
      content: "";
      pointer-events: none;
    }
    .eyebrow { margin-bottom: 12px; color: var(--mc-search-fg-subtle, var(--fg-subtle, #777781)); font-size: 10px; font-weight: 780; letter-spacing: .1em; text-transform: uppercase; }
    .preview h2 { max-width: 230px; margin: 0; color: var(--mc-search-fg, var(--fg, #17171a)); font-size: 20px; font-weight: 720; line-height: 1.22; letter-spacing: -.02em; }
    .preview p { max-width: 235px; margin: 11px 0 0; font-size: 12px; line-height: 1.6; }
    .facts { display: grid; gap: 8px; margin: 18px 0 0; }
    .fact { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 8px; font-size: 11px; }
    .fact dt { color: var(--mc-search-fg-subtle, var(--fg-subtle, #777781)); }
    .fact dd { margin: 0; overflow-wrap: anywhere; }
    .state { display: grid; min-height: 250px; padding: 34px; place-content: center; justify-items: center; color: var(--mc-search-fg-secondary, var(--fg-muted, #62626b)); font-size: 13px; text-align: center; }
    .empty-mark {
      display: grid;
      width: 42px;
      height: 42px;
      margin-bottom: 14px;
      place-items: center;
      color: var(--mc-search-focus, var(--accent, #5865f2));
      background: var(--mc-search-active-bg, var(--surface-3, #f0f0f4));
      border: 1px solid var(--mc-search-border, var(--border, #dedee5));
      border-radius: 13px;
      box-shadow: 0 5px 18px rgb(0 0 0 / 7%);
    }
    .empty-mark svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.8; }
    .state strong { color: var(--mc-search-fg, var(--fg, #17171a)); font-size: 14px; font-weight: 680; }
    .state-copy { max-width: 300px; margin-top: 6px; color: var(--mc-search-fg-subtle, var(--fg-subtle, #777781)); font-size: 12px; line-height: 1.5; }
    .collection-state { padding: 8px 9px; color: var(--mc-search-fg-subtle, var(--fg-subtle, #777781)); font-size: 11px; }
    .collection-state.error { color: var(--mc-search-danger, var(--danger, #b42318)); }
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-height: 47px;
      padding: 8px 15px;
      color: var(--mc-search-fg-subtle, var(--fg-subtle, #777781));
      font-size: 10px;
      background: var(--mc-search-substrate, var(--surface-1, #f7f7f9));
      border-top: 1px solid var(--mc-search-border, var(--border, #dedee5));
    }
    .hints { display: flex; flex-wrap: wrap; gap: 12px; }
    .hint { display: inline-flex; align-items: center; gap: 5px; }
    .powered-by {
      display: inline-flex;
      flex: none;
      align-items: center;
      gap: var(--mc-search-powered-by-gap, 5px);
      color: var(--mc-search-powered-by-color, var(--fg-subtle, #777781));
      font-weight: 650;
      opacity: var(--mc-search-powered-by-opacity, .88);
      white-space: nowrap;
    }
    .powered-mark { display: inline-grid; width: 15px; height: 15px; place-items: center; color: var(--mc-search-focus, var(--accent, #5865f2)); font-size: 13px; }
    .sr-status { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    @media (prefers-color-scheme: dark) {
      :host { color: var(--mc-search-fg, var(--fg, #f3f3f5)); }
      dialog, .launcher { background: var(--mc-search-surface, var(--surface-2, #202024)); border-color: var(--mc-search-border, var(--border, #3b3b43)); }
      .collection-heading { background: var(--mc-search-surface, var(--surface-2, #1d1d21)); }
      .option[data-active="true"] { background: var(--mc-search-active-bg, var(--surface-3, #303037)); }
      .preview, .footer { background: var(--mc-search-substrate, var(--surface-1, #18181c)); border-color: var(--mc-search-border, var(--border, #3b3b43)); }
      .empty-mark { background: var(--mc-search-active-bg, var(--surface-3, #303037)); border-color: var(--mc-search-border, var(--border, #3b3b43)); }
      input, .preview h2 { color: var(--mc-search-fg, var(--fg, #f3f3f5)); }
    }
    @media (max-width: 680px) {
      dialog { width: calc(100vw - 24px); max-height: calc(100dvh - 24px); margin-top: 12px; }
      .body { display: block; min-height: 0; }
      .list { max-height: calc(100dvh - 128px); }
      .preview { display: none; }
      .option { min-height: max(var(--mc-search-row-height, 42px), 44px); }
      .footer { align-items: flex-start; flex-direction: column; }
      .footer { padding-bottom: max(8px, env(safe-area-inset-bottom)); }
      .powered-by { align-self: flex-end; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
    @media (forced-colors: active) { dialog, .option, .launcher { border: 1px solid CanvasText; } .option[data-active="true"] { outline: 2px solid Highlight; } }
  `;

  @property() placeholder = "Search this site";
  @property() shortcut = "mod+k";
  @property({ type: Boolean, attribute: "show-launcher" }) showLauncher = true;
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: Boolean, attribute: "preserve-query" }) preserveQuery = false;
  @property({ attribute: false }) collections: readonly SearchCollection[] = [];
  @property({ attribute: false }) statusMessage = "";
  /** Runtime lifecycle phase from the provider adapter (booting, ready, error, …). */
  @property() phase = "idle";

  @state() private query = "";
  @state() private resultStates: readonly CollectionResultState[] = [];
  @state() private activeKey = "";
  @state() private opened = false;
  @state() private mode = "";
  @state() private modeLabel = "";
  @state() private recents: readonly RecentEntry[] = [];

  private readonly registry = new SearchCollectionRegistry();
  private searchAbort?: AbortController;
  private generation = 0;
  private invoker: Element | null = null;
  private readonly recentCollection: SearchCollection = {
    id: "__recent",
    label: "Recent",
    order: Number.MIN_SAFE_INTEGER,
    emptyQuery: true,
    search: () => [],
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.registry.replaceAll(this.collections);
    this.recents = this.readRecents();
    if (typeof window !== "undefined") window.addEventListener("keydown", this.onGlobalKeydown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.searchAbort?.abort();
    if (this.renderRoot.querySelector<HTMLDialogElement>("dialog")?.open) this.close();
    if (typeof window !== "undefined") window.removeEventListener("keydown", this.onGlobalKeydown);
  }

  protected updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("collections")) {
      this.registry.replaceAll(this.collections);
      if (this.opened) void this.runSearch();
    }
  }

  registerCollection(collection: SearchCollection): () => void {
    const dispose = this.registry.register(collection);
    if (this.opened) void this.runSearch();
    return () => {
      dispose();
      if (this.opened) void this.runSearch();
    };
  }

  setMode(mode: string): void {
    if (mode && this.registry.list(mode).length === 0) throw new Error(`unknown or unavailable search mode: ${mode}`);
    this.mode = mode;
    this.modeLabel = mode ? (this.registry.list(mode)[0]?.label ?? mode) : "";
    if (this.opened) void this.runSearch();
  }

  async open(): Promise<void> {
    if (this.disabled) return;
    const dialog = this.renderRoot.querySelector("dialog");
    if (!dialog || dialog.open) return;
    this.invoker = typeof document === "undefined" ? null : document.activeElement;
    dialog.showModal();
    this.opened = true;
    this.setAttribute("open", "");
    this.activeKey = "";
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLInputElement>("input")?.focus();
    await this.runSearch();
  }

  close(): void {
    this.renderRoot.querySelector("dialog")?.close();
  }

  private readonly onGlobalKeydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const typing = target?.matches("input, textarea, select, [contenteditable='true']");
    const matches = this.shortcut.toLowerCase() === "mod+k" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
    if (this.disabled || !matches || (typing && !this.opened)) return;
    event.preventDefault();
    if (this.opened) this.close();
    else void this.open();
  };

  private onDialogClose(): void {
    this.opened = false;
    this.removeAttribute("open");
    this.searchAbort?.abort();
    this.resultStates = [];
    this.activeKey = "";
    if (!this.preserveQuery) {
      this.query = "";
      this.mode = "";
      this.modeLabel = "";
    }
    if (this.invoker instanceof HTMLElement && this.invoker.isConnected) this.invoker.focus();
    this.invoker = null;
  }

  private onInput(event: Event): void {
    if (event instanceof InputEvent && event.isComposing) return;
    const raw = (event.currentTarget as HTMLInputElement).value;
    if (!this.mode) {
      const parsed = parseSearchInput(raw, this.registry.list(""));
      this.query = parsed.query;
      this.mode = parsed.mode;
      this.modeLabel = parsed.modeLabel;
    } else {
      this.query = raw;
    }
    this.dispatchEvent(new CustomEvent("mc-search-query", {
      detail: { query: this.query, mode: this.mode },
      bubbles: true,
      composed: true,
    }));
    void this.runSearch();
  }

  private async runSearch(): Promise<void> {
    const generation = ++this.generation;
    this.searchAbort?.abort();
    const abort = new AbortController();
    this.searchAbort = abort;
    const query = this.query.trim();
    const eligible = this.registry.list(this.mode).filter((collection) => {
      if (!query) return collection.emptyQuery === true;
      return query.length >= (collection.minQueryLength ?? 1);
    });
    this.resultStates = eligible.map((collection) => ({ collection, status: "loading", items: [] }));
    if (eligible.length === 0) {
      this.activeKey = "";
      return;
    }
    await Promise.all(eligible.map(async (collection) => {
      try {
        const items = await collection.search({
          query,
          mode: "",
          signal: abort.signal,
          limit: collection.limit ?? 10,
          publish: (partial) => {
            if (abort.signal.aborted || generation !== this.generation) return;
            this.replaceState(collection.id, {
              collection,
              status: "ready",
              items: partial.slice(0, collection.limit ?? 10).map((item) => ({ ...item, collectionId: collection.id })),
            });
          },
        });
        if (abort.signal.aborted || generation !== this.generation) return;
        const normalized = items.slice(0, collection.limit ?? 10).map((item) => ({
          ...item,
          collectionId: collection.id,
        }));
        this.replaceState(collection.id, { collection, status: "ready", items: normalized });
      } catch (error) {
        if (abort.signal.aborted || generation !== this.generation) return;
        const message = error instanceof Error ? error.message : String(error);
        this.replaceState(collection.id, { collection, status: "error", items: [], error: message });
        this.dispatchEvent(new CustomEvent("mc-search-error", {
          detail: { collectionId: collection.id, error: message },
          bubbles: true,
          composed: true,
        }));
      }
    }));
  }

  private replaceState(id: string, state: CollectionResultState): void {
    this.resultStates = this.resultStates.map((current) => current.collection.id === id ? state : current);
    const visible = this.visibleItems();
    if (!visible.some((item) => optionKey(item) === this.activeKey)) {
      this.activeKey = visible.find((item) => !item.disabled) ? optionKey(visible.find((item) => !item.disabled)!) : "";
    }
  }

  private visibleStates(): readonly CollectionResultState[] {
    if (this.query.trim()) return this.resultStates;
    const liveItems = this.resultStates.flatMap((state) => state.items);
    const recentItems = deriveLiveRecents(this.recents, liveItems);
    if (recentItems.length === 0) return this.resultStates;
    const keys = new Set(recentItems.map(optionKey));
    return [
      { collection: this.recentCollection, status: "ready", items: recentItems },
      ...this.resultStates.map((state) => ({ ...state, items: state.items.filter((item) => !keys.has(optionKey(item))) })),
    ];
  }

  private visibleItems(): SearchItem[] {
    return this.visibleStates().flatMap((state) => state.items);
  }

  private moveActive(delta: number): void {
    const items = this.visibleItems().filter((item) => !item.disabled);
    if (items.length === 0) return;
    const current = items.findIndex((item) => optionKey(item) === this.activeKey);
    const next = Math.max(0, Math.min(items.length - 1, current < 0 ? 0 : current + delta));
    this.activeKey = optionKey(items[next]);
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(this.activeKey)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }

  private onInputKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "Backspace" && this.mode && !(event.currentTarget as HTMLInputElement).value) {
      event.preventDefault();
      this.mode = "";
      this.modeLabel = "";
      void this.runSearch();
      return;
    }
    if (event.key === "Escape" && this.mode) {
      event.preventDefault();
      event.stopPropagation();
      this.mode = "";
      this.modeLabel = "";
      void this.runSearch();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const items = this.visibleItems().filter((item) => !item.disabled);
      const item = event.key === "Home" ? items[0] : items.at(-1);
      if (item) this.activeKey = optionKey(item);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = this.visibleItems().find((candidate) => optionKey(candidate) === this.activeKey);
      if (item) this.select(item, "keyboard");
    }
  }

  private select(item: SearchItem, method: SearchSelectionDetail["method"]): void {
    if (item.disabled) return;
    const collection = this.registry.get(item.collectionId);
    if (!collection) return;
    const detail: SearchSelectionDetail = { item, collection, query: this.query, mode: "", method };
    const accepted = this.dispatchEvent(new CustomEvent<SearchSelectionDetail>("mc-search-select", {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true,
    }));
    if (!accepted) return;
    this.recents = recordRecent(this.recents, item);
    this.writeRecents(this.recents);
    void collection.select?.(detail);
    const href = sanitizeNavigationUrl(item.href ?? item.url, typeof location !== "undefined" ? location.origin : undefined);
    if (href && typeof window !== "undefined") window.location.assign(href);
    this.close();
  }

  private readRecents(): readonly RecentEntry[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]") as unknown;
      return Array.isArray(parsed) ? pruneRecents(parsed as RecentEntry[]) : [];
    } catch {
      return [];
    }
  }

  private writeRecents(entries: readonly RecentEntry[]): void {
    try {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Storage denial/quota is intentionally non-fatal.
    }
  }

  private renderCollection(state: CollectionResultState) {
    const headingId = `mc-search-heading-${state.collection.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const listId = `mc-search-list-${state.collection.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    // Keep non-option status text outside the listbox; only options live in role=listbox.
    return html`<section class="collection" part="collection">
      <div class="collection-heading" part="collection-heading" id=${headingId}>
        <span>${state.collection.label}</span><span>${state.status === "ready" ? state.items.length : ""}</span>
      </div>
      ${state.status === "loading" ? html`<div class="collection-state" part="loading" role="status">Searching…</div>` : nothing}
      ${state.status === "error" ? html`<div class="collection-state error" part="error" role="alert">${state.error}</div>` : nothing}
      ${state.status === "ready" && state.items.length === 0 ? html`<div class="collection-state" role="status">No matches</div>` : nothing}
      ${state.items.length > 0
        ? html`<div
            class="collection-options"
            role="listbox"
            id=${listId}
            aria-labelledby=${headingId}
            aria-label=${state.collection.label}
          >${state.items.map((item) => this.renderOption(item))}</div>`
        : nothing}
    </section>`;
  }

  private renderOption(item: SearchItem) {
    const key = optionKey(item);
    const active = key === this.activeKey;
    const id = `mc-search-option-${encodeURIComponent(key)}`;
    return html`<button
      class="option"
      part="option"
      id=${id}
      role="option"
      aria-selected=${String(active)}
      aria-disabled=${String(Boolean(item.disabled))}
      data-active=${String(active)}
      data-option-key=${key}
      @pointermove=${() => { if (!item.disabled) this.activeKey = key; }}
      @pointerdown=${(event: PointerEvent) => event.preventDefault()}
      @click=${() => this.select(item, "pointer")}
    >
      <span class="option-icon" part="option-icon" aria-hidden="true">${printableIcon(item)}</span>
      <span class="option-copy">
        <span class="option-label" part="option-label">${item.label}</span>
        ${item.secondary ? html`<span class="option-secondary" part="option-secondary">${item.secondary}</span>` : nothing}
      </span>
      ${item.meta ? html`<span class="option-meta" part="option-meta">${item.meta}</span>` : nothing}
    </button>`;
  }

  private renderPreview() {
    const item = this.visibleItems().find((candidate) => optionKey(candidate) === this.activeKey);
    if (!item) return html`<div class="eyebrow">Search</div><h2>Find anything</h2><p>Results from every available collection stay distinct and easy to scan.</p>`;
    const preview = item.preview;
    return html`
      <div class="eyebrow">${preview?.eyebrow ?? item.kind}</div>
      <h2>${preview?.title ?? item.label}</h2>
      ${preview?.description || item.secondary ? html`<p>${preview?.description ?? item.secondary}</p>` : nothing}
      ${preview?.facts?.length ? html`<dl class="facts">${preview.facts.map((fact) => html`<div class="fact"><dt>${fact.label}</dt><dd>${fact.value}</dd></div>`)}</dl>` : nothing}
    `;
  }

  private renderSearchMark() {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.75" cy="10.75" r="6.25"></circle><path d="m15.5 15.5 4 4"></path></svg>`;
  }

  /** Active listbox id for aria-controls (matches per-collection listbox). */
  private activeListboxId(): string | typeof nothing {
    const item = this.visibleItems().find((candidate) => optionKey(candidate) === this.activeKey)
      ?? this.visibleItems()[0];
    if (!item) {
      const first = this.visibleStates()[0]?.collection.id;
      return first ? `mc-search-list-${first.replace(/[^a-zA-Z0-9_-]/g, "-")}` : nothing;
    }
    return `mc-search-list-${item.collectionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  private renderBody() {
    // Only block the palette when there is nothing to show yet (boot/error without collections).
    const blockingStatus = this.statusMessage
      && this.collections.length === 0
      && this.resultStates.length === 0
      && (this.phase === "error" || this.phase === "booting" || this.phase === "loading" || this.phase === "idle");
    if (blockingStatus) return html`<div class="state" part="error">${this.statusMessage}</div>`;
    if (!this.query.trim() && this.resultStates.length === 0) {
      return html`<div class="state" part="empty"><span class="empty-mark" aria-hidden="true">${this.renderSearchMark()}</span><strong>Search this site</strong><span class="state-copy">${this.statusMessage && this.phase !== "ready" ? this.statusMessage : "Start typing to search every available collection."}</span></div>`;
    }
    if (this.query.trim() && this.resultStates.length === 0) {
      return html`<div class="state" part="empty"><span class="empty-mark" aria-hidden="true">${this.renderSearchMark()}</span><strong>No collections available</strong><span class="state-copy">${this.statusMessage || "The local search index is not ready yet."}</span></div>`;
    }
    return this.visibleStates().map((state) => this.renderCollection(state));
  }

  render() {
    const activeId = this.activeKey ? `mc-search-option-${encodeURIComponent(this.activeKey)}` : nothing;
    const listboxId = this.activeListboxId();
    return html`
      ${this.showLauncher ? html`<button class="launcher" part="launcher" type="button" ?disabled=${this.disabled} @click=${() => this.open()}><span>Search</span><kbd part="shortcut">${/mac/i.test(globalThis.navigator?.platform ?? "") ? "⌘K" : "Ctrl K"}</kbd></button>` : nothing}
      <dialog part="dialog" aria-label="Site search" @close=${this.onDialogClose} @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.close(); }}>
        <div class="input-row" part="input-row">
          <span class="search-icon" part="search-icon" aria-hidden="true">${this.renderSearchMark()}</span>
          ${this.mode ? html`<span class="mode-chip" part="mode-chip">${this.modeLabel || this.mode}</span>` : nothing}
          <input
            part="input"
            type="search"
            role="combobox"
            autocomplete="off"
            spellcheck="false"
            aria-autocomplete="list"
            aria-controls=${listboxId}
            aria-expanded=${String(this.opened)}
            aria-activedescendant=${activeId}
            .value=${this.query}
            placeholder=${this.mode ? (this.registry.list(this.mode)[0]?.placeholder ?? `Search ${this.modeLabel}`) : this.placeholder}
            @input=${this.onInput}
            @compositionend=${this.onInput}
            @keydown=${this.onInputKeydown}
          >
          <kbd part="escape-key">Esc</kbd>
        </div>
        <div class="body" part="body">
          <div class="list" part="list" id="mc-search-list" aria-label="Search results">${this.renderBody()}</div>
          <aside class="preview" part="preview">${this.renderPreview()}</aside>
        </div>
        <footer class="footer" part="footer">
          <span class="hints"><span class="hint"><kbd>↑↓</kbd> navigate</span><span class="hint"><kbd>↵</kbd> open</span><span class="hint"><kbd>Esc</kbd> close</span></span>
          <span class="powered-by" part="powered-by"><span class="powered-mark" aria-hidden="true">✦</span>Powered by AgentOS</span>
        </footer>
        <span class="sr-status" role="status" aria-live="polite">${this.resultStates.some((state) => state.status === "loading") ? "Searching" : `${this.visibleItems().length} results`}</span>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mc-site-search": McSiteSearch;
  }
}
