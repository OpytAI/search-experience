import { css } from "lit";

/** Palette styles for <mc-site-search>. */
export const mcSiteSearchStyles = css`
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
      color: var(--mc-search-fg, var(--fg, #17171a));
      font: inherit;
      font-size: 13px;
      font-weight: 550;
      background: var(--mc-search-surface, var(--surface-2, #fff));
      border: 1px solid var(--mc-search-border, var(--border, #dedee5));
      border-radius: var(--mc-search-row-radius, var(--radius-button, 8px));
      box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
      cursor: pointer;
      transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
    }
    .launcher:hover {
      background: var(--mc-search-elevated, var(--surface-3, #f4f4f7));
      border-color: color-mix(in srgb, var(--mc-search-border, #dedee5) 55%, var(--mc-search-fg, #17171a));
      box-shadow: 0 2px 6px rgb(0 0 0 / 8%);
    }
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
      color: var(--mc-search-fg, var(--fg, #17171a));
      text-align: left;
      font: inherit;
      background: transparent;
      border: 0;
      border-radius: var(--mc-search-row-radius, var(--radius-button, 8px));
      cursor: pointer;
      transition: background-color 100ms ease, color 100ms ease;
    }
    .option:hover:not([aria-disabled="true"]),
    .option[data-active="true"] {
      color: var(--mc-search-active-fg, var(--mc-search-fg, var(--fg, #17171a)));
      background: var(--mc-search-active-bg, var(--surface-3, #ebebf0));
    }
    .option:focus-visible { outline-offset: -2px; }
    .option[aria-disabled="true"] { opacity: .52; cursor: not-allowed; }
    .option-icon {
      display: grid;
      width: var(--mc-search-icon-size, 18px);
      height: var(--mc-search-icon-size, 18px);
      place-items: center;
      color: var(--mc-search-fg-secondary, var(--fg-muted, #4f4f58));
      font-size: 13px;
    }
    .option:hover:not([aria-disabled="true"]) .option-icon,
    .option[data-active="true"] .option-icon {
      color: var(--mc-search-fg, var(--fg, #17171a));
    }
    .option-copy { min-width: 0; }
    .option-label { display: block; overflow: hidden; font-size: 13px; font-weight: 620; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
    .option-secondary {
      display: block;
      margin-top: 2px;
      overflow: hidden;
      color: var(--mc-search-fg-secondary, var(--fg-muted, #4f4f58));
      font-size: 11px;
      line-height: 1.3;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .option:hover:not([aria-disabled="true"]) .option-secondary,
    .option[data-active="true"] .option-secondary {
      color: var(--mc-search-fg-secondary-strong, #3a3a42);
    }
    .option-meta { color: var(--mc-search-fg-subtle, var(--fg-subtle, #5c5c66)); font: 500 10px/1.2 var(--mc-search-font-mono, var(--font-mono, ui-monospace, monospace)); }
    /* Outer clips decorative glow so scrollbars only appear when content overflows. */
    .preview {
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      color: var(--mc-search-fg-secondary, var(--fg-muted, #3f3f48));
      background: var(--mc-search-substrate, var(--surface-1, #f7f7f9));
      border-left: 1px solid var(--mc-search-border, var(--border, #dedee5));
    }
    .preview::after {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 120px;
      height: 120px;
      background: radial-gradient(circle at 100% 100%, var(--mc-search-preview-glow, color-mix(in srgb, var(--mc-search-focus, #5865f2) 14%, transparent)), transparent 70%);
      content: "";
      pointer-events: none;
      z-index: 0;
    }
    .preview-inner {
      position: relative;
      z-index: 1;
      flex: 1 1 auto;
      min-height: 0;
      padding: 26px;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-width: thin;
      scrollbar-color: var(--mc-search-scrollbar, #b7b7c0) transparent;
    }
    .preview-inner::-webkit-scrollbar { width: 8px; }
    .preview-inner::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--mc-search-scrollbar, #b7b7c0) 80%, transparent);
      border-radius: 999px;
      border: 2px solid transparent;
      background-clip: padding-box;
    }
    .eyebrow { margin-bottom: 12px; color: var(--mc-search-fg-subtle, var(--fg-subtle, #5c5c66)); font-size: 10px; font-weight: 780; letter-spacing: .1em; text-transform: uppercase; }
    .preview h2 { max-width: 230px; margin: 0; color: var(--mc-search-fg, var(--fg, #17171a)); font-size: 20px; font-weight: 720; line-height: 1.22; letter-spacing: -.02em; }
    .preview p { max-width: 235px; margin: 11px 0 0; color: var(--mc-search-fg-secondary, var(--fg-muted, #3f3f48)); font-size: 12px; line-height: 1.6; }
    .facts { display: grid; gap: 8px; margin: 18px 0 0; }
    .fact { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 8px; font-size: 11px; }
    .fact dt { color: var(--mc-search-fg-subtle, var(--fg-subtle, #5c5c66)); }
    .fact dd { margin: 0; color: var(--mc-search-fg, var(--fg, #17171a)); overflow-wrap: anywhere; }
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
      /*
       * Pin dark tokens on the host so muted --fg-* from the page cannot keep
       * labels/secondary near background luminance (inactive rows were unreadable).
       */
      :host {
        color: #f4f4f7;
        --mc-search-fg: #f4f4f7;
        --mc-search-fg-secondary: #d0d0d8;
        --mc-search-fg-secondary-strong: #ececf1;
        --mc-search-fg-subtle: #b6b6c0;
        --mc-search-active-fg: #ffffff;
        --mc-search-active-bg: #3d3d48;
        --mc-search-surface: #24242a;
        --mc-search-substrate: #1a1a1f;
        --mc-search-elevated: #2e2e36;
        --mc-search-border: #45454f;
        --mc-search-scrollbar: #7a7a86;
      }
      dialog, .launcher {
        color: #f4f4f7;
        background: var(--mc-search-surface);
        border-color: var(--mc-search-border);
      }
      .launcher:hover { background: var(--mc-search-elevated); }
      .collection-heading {
        color: #c2c2cc;
        background: var(--mc-search-surface);
      }
      .option {
        color: #f4f4f7;
      }
      .option-label {
        color: #f4f4f7;
      }
      .option-secondary {
        color: #d0d0d8;
      }
      .option-meta {
        color: #b6b6c0;
      }
      .option-icon {
        color: #d0d0d8;
      }
      .option:hover:not([aria-disabled="true"]),
      .option[data-active="true"] {
        color: #ffffff;
        background: var(--mc-search-active-bg);
      }
      .option:hover:not([aria-disabled="true"]) .option-label,
      .option[data-active="true"] .option-label {
        color: #ffffff;
      }
      .option:hover:not([aria-disabled="true"]) .option-secondary,
      .option[data-active="true"] .option-secondary {
        color: #ececf1;
      }
      .option:hover:not([aria-disabled="true"]) .option-icon,
      .option[data-active="true"] .option-icon {
        color: #ffffff;
      }
      .preview, .footer {
        background: var(--mc-search-substrate);
        border-color: var(--mc-search-border);
      }
      .eyebrow, .fact dt, .footer, .powered-by, .state-copy, .collection-state {
        color: #b6b6c0;
      }
      .preview p {
        color: #d0d0d8;
      }
      .empty-mark {
        background: var(--mc-search-active-bg);
        border-color: var(--mc-search-border);
      }
      input, .preview h2, .fact dd, .state strong {
        color: #f4f4f7;
      }
      kbd {
        color: #d0d0d8;
        background: #2e2e36;
        border-color: #45454f;
      }
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
