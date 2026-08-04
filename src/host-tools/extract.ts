import type { ExtractedBlock, SearchExtractInput, SearchExtractOutput } from "../protocol/host-tools.js";
import { sanitizeHttpUrl } from "../security/urls.js";

/**
 * Lightweight HTML extraction for the host tool surface.
 * Only http(s) links and canonicals are retained.
 *
 * Titles: first H1 in main content wins (palette labels). Document <title> is
 * fallback only. Description: meta description, else first substantial block.
 */

const SKIP_TAGS = new Set([
  "script", "style", "template", "noscript", "svg", "canvas", "form", "dialog", "nav", "footer", "header",
]);

/** UI chrome that must not enter index body/snippets (docs site + similar layouts). */
const STRIP_FROM_MAIN = [
  /<div\b[^>]*\bpage-meta\b[^>]*>[\s\S]*?<\/div>/gi,
  /<div\b[^>]*\btype-map\b[^>]*>[\s\S]*?<\/div>/gi,
  /<div\b[^>]*\bhub-columns\b[^>]*>[\s\S]*?<\/div>/gi,
  /<p\b[^>]*\barticle-nav\b[^>]*>[\s\S]*?<\/p>/gi,
  /<nav\b[^>]*>[\s\S]*?<\/nav>/gi,
];

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function metaContent(html: string, name: string): string {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']` +
      `|<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`,
    "i",
  );
  const m = html.match(re);
  return decodeEntities((m?.[1] ?? m?.[2] ?? "").trim());
}

function attrMatch(html: string, tagRe: RegExp, attr: string): string {
  const m = html.match(tagRe);
  if (!m) return "";
  const tag = m[0];
  const a = tag.match(new RegExp(`${attr}=["']([^"']*)["']`, "i"));
  return a?.[1] ? decodeEntities(a[1]) : "";
}

function removeSkipped(html: string): string {
  let out = html;
  for (const tag of SKIP_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    out = out.replace(re, " ");
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  return out;
}

function extractMain(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1];
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article) return article[1];
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body?.[1] ?? html;
}

/** Drop docs-site chrome that sits inside <main> but is not prose. */
function scrubMainChrome(fragment: string): string {
  let out = fragment;
  for (const re of STRIP_FROM_MAIN) {
    out = out.replace(re, " ");
  }
  // Eyebrow / type label paragraphs (short Diátaxis labels).
  out = out.replace(
    /<p\b[^>]*\beyebrow\b[^>]*>[\s\S]*?<\/p>/gi,
    " ",
  );
  return out;
}

function extractLinks(fragment: string, baseUrl: string): string[] {
  const links: string[] = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) {
    const safe = sanitizeHttpUrl(m[1], baseUrl);
    if (safe) links.push(safe);
  }
  return [...new Set(links)];
}

const DIATAXIS_LABEL = /^(tutorial|tutorials|how-to|howto|reference|explanation|blog|docs|documentation)$/i;

function extractBlocks(fragment: string): ExtractedBlock[] {
  const headings = ["", "", "", "", "", ""];
  const blocks: ExtractedBlock[] = [];
  const tokenRe = /<(h[1-6]|p|li|pre|blockquote|td|th|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(fragment))) {
    const tag = m[1].toLowerCase();
    const text = stripTags(m[2]);
    if (!text) continue;
    const hm = /^h([1-6])$/.exec(tag);
    if (hm) {
      const level = Number(hm[1]);
      headings[level - 1] = text;
      for (let i = level; i < 6; i++) headings[i] = "";
      continue;
    }
    // Skip type labels and other non-prose crumbs.
    if (text.length < 28 || DIATAXIS_LABEL.test(text)) continue;
    blocks.push({ heading: headings.filter(Boolean).join(" › "), text });
  }
  if (blocks.length === 0) {
    const text = stripTags(fragment);
    if (text) blocks.push({ heading: "", text });
  }
  return blocks;
}

function extractH1(fragment: string): string {
  const m = fragment.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripTags(m[1]) : "";
}

function resolveDescription(metaDescription: string, blocks: readonly ExtractedBlock[]): string {
  if (metaDescription.trim()) return metaDescription.trim();
  for (const block of blocks) {
    const text = block.text.trim();
    if (text.length >= 40) return text;
  }
  return "";
}

function pathFallbackTitle(url: string): string {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop() || new URL(url).hostname;
  } catch {
    return "untitled";
  }
}

export function runSearchExtract(input: SearchExtractInput): SearchExtractOutput {
  const base = sanitizeHttpUrl(input.url) ?? input.url;
  const html = input.html ?? "";
  const cleaned = removeSkipped(html);
  const main = scrubMainChrome(extractMain(cleaned));
  const blocks = extractBlocks(main);
  const h1 = extractH1(main);
  const docTitle = stripTags(
    cleaned.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
  );
  // H1 is the product label. Document title is last-resort (sites should set title = H1).
  const title = h1 || docTitle || pathFallbackTitle(base);
  const description = resolveDescription(metaContent(cleaned, "description"), blocks);
  const robots = metaContent(cleaned, "robots");
  const noindex = /(?:^|[,\s])noindex(?:$|[,\s])/i.test(robots);
  let canonicalUrl = base;
  const canonicalHref = attrMatch(cleaned, /<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/i, "href");
  if (canonicalHref) {
    const safe = sanitizeHttpUrl(canonicalHref, base);
    if (safe) canonicalUrl = safe;
  }
  const lang = attrMatch(cleaned, /<html\b[^>]*>/i, "lang");
  return {
    requestedUrl: base,
    canonicalUrl,
    title,
    description,
    language: lang,
    noindex,
    blocks,
    links: extractLinks(main, base),
  };
}
