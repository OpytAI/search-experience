/**
 * FTS5 query construction oracle for tests.
 * Production FTS query construction lives in guest searchd.
 */

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}/gu;

export function buildFts5Query(input: string, maxTokens = 16): string {
  const normalized = input.normalize("NFKC").trim();
  if (!normalized) return "";
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of normalized.matchAll(TOKEN)) {
    const term = match[0].toLocaleLowerCase("en-US");
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(`"${term.replaceAll('"', '""')}"*`);
    if (terms.length >= maxTokens) break;
  }
  return terms.join(" AND ");
}
