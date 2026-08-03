import { McSiteSearch } from "./ui/mc-site-search/element.js";

export function defineSearchElements(): typeof McSiteSearch {
  if (!customElements.get("mc-site-search")) {
    customElements.define("mc-site-search", McSiteSearch);
  }
  return McSiteSearch;
}

defineSearchElements();
