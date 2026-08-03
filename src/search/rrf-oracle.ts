/**
 * Reciprocal-rank fusion oracle for contract tests only.
 * Production fusion lives in guest searchd — do not call this from the runtime worker.
 */

export interface RankedCandidate {
  id: string | number;
  rank: number;
}

export interface FusedCandidate {
  id: string;
  score: number;
  lexicalRank?: number;
  semanticRank?: number;
}

export interface FusionOptions {
  rrfK?: number;
  lexicalWeight?: number;
  semanticWeight?: number;
}

export function reciprocalRankFusion(
  lexical: readonly RankedCandidate[],
  semantic: readonly RankedCandidate[],
  options: FusionOptions = {},
): readonly FusedCandidate[] {
  const rrfK = options.rrfK ?? 60;
  const lexicalWeight = options.lexicalWeight ?? 1;
  const semanticWeight = options.semanticWeight ?? 1;
  if (!Number.isFinite(rrfK) || rrfK <= 0) throw new Error("rrfK must be positive");

  const fused = new Map<string, FusedCandidate>();
  const add = (candidate: RankedCandidate, source: "lexical" | "semantic", weight: number) => {
    if (!Number.isInteger(candidate.rank) || candidate.rank < 1) {
      throw new Error(`${source} rank must be a positive integer`);
    }
    const id = String(candidate.id);
    const current = fused.get(id) ?? { id, score: 0 };
    current.score += weight / (rrfK + candidate.rank);
    if (source === "lexical") current.lexicalRank = candidate.rank;
    else current.semanticRank = candidate.rank;
    fused.set(id, current);
  };
  for (const candidate of lexical) add(candidate, "lexical", lexicalWeight);
  for (const candidate of semantic) add(candidate, "semantic", semanticWeight);
  return [...fused.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
