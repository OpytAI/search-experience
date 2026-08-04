import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { mcSiteSearchStyles } from "./styles.js";
import { SearchCollectionRegistry } from "../palette/registry.js";
import { parseSearchInput } from "../palette/modes.js";
import {
  deriveLiveRecents,
  pruneRecents,
  recentKey,
  recordRecent,
  resolveActiveKey,
  type RecentEntry,
} from "../palette/recents.js";
import { rankCollectionStatesForQuery } from "../palette/collection-rank.js";
import type {
  CollectionResultState,
  SearchCollection,
  SearchItem,
  SearchSelectionDetail,
} from "../palette/types.js";
import { sanitizeNavigationUrl } from "../../security/urls.js";

/** Stable option key = collectionId + id (survives hybrid reordering). */
const optionKey = recentKey;
const RECENT_STORAGE_KEY = "agentos-search:recents:v1";

function printableIcon(item: SearchItem): string {
  return item.icon?.text || item.icon?.label?.slice(0, 1) || (item.kind === "page" ? "↗" : "•");
}

export class McSiteSearch extends LitElement {
  static styles = mcSiteSearchStyles;

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
  private layoutMql: MediaQueryList | null = null;
  private viewportBound = false;
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
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", this.onGlobalKeydown);
      this.layoutMql = window.matchMedia("(max-width: 680px)");
      this.layoutMql.addEventListener("change", this.syncLayoutMode);
      this.syncLayoutMode();
    } else {
      this.setAttribute("layout", "palette");
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.searchAbort?.abort();
    this.unbindViewport();
    this.layoutMql?.removeEventListener("change", this.syncLayoutMode);
    this.layoutMql = null;
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
    this.syncLayoutMode();
    this.invoker = typeof document === "undefined" ? null : document.activeElement;
    this.bindViewport();
    dialog.showModal();
    this.opened = true;
    this.setAttribute("open", "");
    this.activeKey = "";
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    await this.runSearch();
  }

  close(): void {
    this.renderRoot.querySelector("dialog")?.close();
  }

  private readonly syncLayoutMode = (): void => {
    const sheet = this.layoutMql?.matches ?? false;
    this.setAttribute("layout", sheet ? "sheet" : "palette");
    if (this.opened) this.syncViewportMetrics();
  };

  private readonly syncViewportMetrics = (): void => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    const height = vv ? Math.max(1, Math.round(vv.height)) : Math.round(window.innerHeight);
    const offsetTop = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;
    this.style.setProperty("--mc-search-vvh", `${height}px`);
    this.style.setProperty("--mc-search-vvt", `${offsetTop}px`);
  };

  private bindViewport(): void {
    if (typeof window === "undefined" || this.viewportBound) return;
    this.viewportBound = true;
    this.syncViewportMetrics();
    window.visualViewport?.addEventListener("resize", this.syncViewportMetrics);
    window.visualViewport?.addEventListener("scroll", this.syncViewportMetrics);
    window.addEventListener("resize", this.syncViewportMetrics);
  }

  private unbindViewport(): void {
    if (typeof window === "undefined" || !this.viewportBound) return;
    this.viewportBound = false;
    window.visualViewport?.removeEventListener("resize", this.syncViewportMetrics);
    window.visualViewport?.removeEventListener("scroll", this.syncViewportMetrics);
    window.removeEventListener("resize", this.syncViewportMetrics);
    this.style.removeProperty("--mc-search-vvh");
    this.style.removeProperty("--mc-search-vvt");
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
    this.unbindViewport();
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

  private renderCloseMark() {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>`;
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
    // New query generation: show loading shells but do not thrash activeKey until
    // the first result/progress publish for this generation (preserve-active-id on
    // subsequent in-place refinements such as lexical → hybrid).
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
            // Progressive channel: lexical-first, then hybrid reorder, etc.
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

  /**
   * Replace one collection's result state. Always re-resolves activeKey by stable
   * id so hybrid reordering keeps keyboard focus on the same hit.
   */
  private replaceState(id: string, state: CollectionResultState): void {
    this.resultStates = this.resultStates.map((current) => (current.collection.id === id ? state : current));
    this.activeKey = resolveActiveKey(this.activeKey, this.visibleItems());
  }

  private visibleStates(): readonly CollectionResultState[] {
    // Non-empty query: section order follows best title/query fit (RRF alone ties every
    // collection's rank-1 at ~1/61). e.g. blog "Why collections exist" above docs.
    if (this.query.trim()) return rankCollectionStatesForQuery(this.resultStates, this.query);
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
    // Idle preview: complementary to the empty list (do not repeat placeholder / "search this site").
    if (!item) {
      return html`<div class="eyebrow">Preview</div><h2>Result details</h2><p>Highlight a hit to see title, summary, and link here.</p>`;
    }
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
      // Placeholder already says "Search this site" — keep the empty body to one short line.
      const copy = this.statusMessage && this.phase !== "ready"
        ? this.statusMessage
        : "Type to search";
      return html`<div class="state" part="empty"><span class="empty-mark" aria-hidden="true">${this.renderSearchMark()}</span><span class="state-copy">${copy}</span></div>`;
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
          <span class="input-actions" part="input-actions">
            <kbd part="escape-key">Esc</kbd>
            <button
              class="close-btn"
              part="close"
              type="button"
              aria-label="Close search"
              @click=${() => this.close()}
            >${this.renderCloseMark()}</button>
          </span>
        </div>
        <div class="body" part="body">
          <div class="list" part="list" id="mc-search-list" aria-label="Search results">${this.renderBody()}</div>
          <aside class="preview" part="preview"><div class="preview-inner" part="preview-inner">${this.renderPreview()}</div></aside>
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
