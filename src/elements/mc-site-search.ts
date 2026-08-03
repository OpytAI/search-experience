import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SearchCollection, SearchItem, SearchSelectionDetail } from "../search/types.js";

/**
 * Collection-driven site-search palette.
 * VM and indexing policy stay outside this element.
 */
@customElement("mc-site-search")
export class McSiteSearch extends LitElement {
  static override styles = css`
    :host {
      --mc-search-font: ui-sans-serif, system-ui, sans-serif;
      --mc-search-surface: #fffdf9;
      --mc-search-substrate: #f7f2e9;
      --mc-search-fg: #211f1c;
      --mc-search-fg-secondary: #625e57;
      --mc-search-border: #ddd5c9;
      --mc-search-focus: #d9480f;
      --mc-search-width: 920px;
      --mc-search-radius: 22px;
      --mc-search-shadow: 0 32px 100px rgb(52 37 24 / 28%);
      --mc-search-backdrop: rgb(27 22 18 / 58%);
      font-family: var(--mc-search-font);
      color: var(--mc-search-fg);
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --mc-search-surface: #202024;
        --mc-search-substrate: #18181c;
        --mc-search-fg: #f5f5f7;
        --mc-search-fg-secondary: #a1a1aa;
        --mc-search-border: #3f3f46;
        --mc-search-backdrop: rgb(0 0 0 / 58%);
      }
    }

    .backdrop {
      position: fixed;
      inset: 0;
      background: var(--mc-search-backdrop);
      z-index: 9998;
    }

    .panel {
      position: fixed;
      left: 50%;
      top: 12vh;
      transform: translateX(-50%);
      width: min(var(--mc-search-width), calc(100vw - 2rem));
      max-height: min(620px, 76vh);
      background: var(--mc-search-surface);
      border: 1px solid var(--mc-search-border);
      border-radius: var(--mc-search-radius);
      box-shadow: var(--mc-search-shadow);
      display: flex;
      flex-direction: column;
      z-index: 9999;
      overflow: hidden;
    }

    .input-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.9rem 1rem;
      border-bottom: 1px solid var(--mc-search-border);
    }

    input {
      flex: 1;
      border: 0;
      outline: none;
      background: transparent;
      font: inherit;
      font-size: 1.05rem;
      color: inherit;
    }

    .body {
      overflow: auto;
      padding: 0.5rem;
      min-height: 8rem;
    }

    .status {
      padding: 1rem;
      color: var(--mc-search-fg-secondary);
      font-size: 0.9rem;
    }

    .section-label {
      padding: 0.4rem 0.6rem;
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--mc-search-fg-secondary);
    }

    .row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.55rem 0.65rem;
      border-radius: 10px;
      cursor: pointer;
    }

    .row[data-active="true"],
    .row:hover {
      background: var(--mc-search-substrate);
    }

    .footer {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.55rem 0.9rem;
      border-top: 1px solid var(--mc-search-border);
      font-size: 0.75rem;
      color: var(--mc-search-fg-secondary);
    }

    kbd {
      font: inherit;
      font-size: 0.7rem;
      border: 1px solid var(--mc-search-border);
      border-radius: 4px;
      padding: 0.05rem 0.3rem;
    }
  `;

  @property({ type: String })
  placeholder = "Search this site";

  @property({ type: String, attribute: "status-message" })
  statusMessage = "";

  @property({ type: String })
  phase = "idle";

  @property({ type: Array, attribute: false })
  collections: SearchCollection[] = [];

  @state()
  private open = false;

  @state()
  private query = "";

  @state()
  private activeIndex = 0;

  private onKeydown = (event: KeyboardEvent) => {
    const isPalette = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
    if (isPalette) {
      event.preventDefault();
      this.open = !this.open;
      if (this.open) this.updateComplete.then(() => this.focusInput());
      return;
    }
    if (!this.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.open = false;
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKeydown);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("keydown", this.onKeydown);
    super.disconnectedCallback();
  }

  private focusInput(): void {
    this.renderRoot.querySelector<HTMLInputElement>("input")?.focus();
  }

  private flatItems(): { collection: SearchCollection; item: SearchItem }[] {
    const rows: { collection: SearchCollection; item: SearchItem }[] = [];
    for (const collection of this.collections) {
      for (const item of collection.items) rows.push({ collection, item });
    }
    return rows;
  }

  private selectActive(): void {
    const rows = this.flatItems();
    const row = rows[this.activeIndex];
    if (!row) return;
    const detail: SearchSelectionDetail = {
      item: row.item,
      collection: row.collection,
      query: this.query,
    };
    this.dispatchEvent(new CustomEvent("mc-search-select", {
      detail,
      bubbles: true,
      composed: true,
    }));
    if (row.item.url) window.location.assign(row.item.url);
    this.open = false;
  }

  protected override render() {
    if (!this.open) {
      return nothing;
    }

    const rows = this.flatItems();
    return html`
      <div class="backdrop" @click=${() => {
        this.open = false;
      }}></div>
      <div class="panel" part="panel" role="dialog" aria-label="Site search">
        <div class="input-row" part="input-row">
          <span aria-hidden="true">⌕</span>
          <input
            part="input"
            .value=${this.query}
            placeholder=${this.placeholder}
            @input=${(event: Event) => {
              this.query = (event.target as HTMLInputElement).value;
              this.activeIndex = 0;
            }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                this.activeIndex = Math.min(this.activeIndex + 1, Math.max(rows.length - 1, 0));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                this.activeIndex = Math.max(this.activeIndex - 1, 0);
              } else if (event.key === "Enter") {
                event.preventDefault();
                this.selectActive();
              }
            }}
          />
        </div>
        <div class="body" part="body">
          ${this.statusMessage
            ? html`<div class="status" part="status">${this.statusMessage}</div>`
            : nothing}
          ${this.collections.map((collection) => html`
            <div class="section-label" part="section-label">${collection.label}</div>
            ${collection.items.length === 0
              ? html`<div class="status">No results yet.</div>`
              : collection.items.map((item) => {
                const flatIndex = rows.findIndex((row) => row.item.id === item.id);
                return html`
                  <div
                    class="row"
                    part="row"
                    data-active=${flatIndex === this.activeIndex}
                    @click=${() => {
                      this.activeIndex = flatIndex;
                      this.selectActive();
                    }}
                  >
                    <span>${item.title}</span>
                  </div>
                `;
              })}
          `)}
        </div>
        <div class="footer" part="footer">
          <span><kbd>↑↓</kbd> navigate · <kbd>↵</kbd> open · phase: ${this.phase}</span>
          <span>Powered by AgentOS</span>
        </div>
      </div>
    `;
  }

  /** Programmatic open (tests / hosts). */
  show(): void {
    this.open = true;
  }

  hide(): void {
    this.open = false;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mc-site-search": McSiteSearch;
  }
}
