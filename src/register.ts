import { McSiteSearch } from "./elements/mc-site-search.js";

export function defineSearchElements(): typeof McSiteSearch {
  if (!customElements.get("mc-site-search")) {
    customElements.define("mc-site-search", McSiteSearch);
  }
  return McSiteSearch;
}

defineSearchElements();
