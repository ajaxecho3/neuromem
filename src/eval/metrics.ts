/**
 * Retrieval metrics — all pure functions for easy unit testing.
 *
 *   recall@k = |expected ∩ top_k(returned)| / min(|expected|, k)
 *   MRR      = 1 / rank_of_first_relevant   (0 if none found)
 *   nDCG@k   = DCG / IDCG                    (binary relevance)
 *
 * We treat every expected id as equally relevant (binary). If you later
 * want graded relevance, extend BenchQuery.expected_ids to carry weights.
 */

/**
 * recall@k — what fraction of expected ids appear in the top-k returned.
 * Normalized by min(|expected|, k) so queries with fewer expected ids than
 * k are still scored fairly.
 */
export function recallAtK(
  expected: readonly string[],
  returned: readonly string[],
  k: number,
): number {
  if (expected.length === 0) return 1;
  const topK = new Set(returned.slice(0, k));
  let hits = 0;
  for (const id of expected) if (topK.has(id)) hits++;
  return hits / Math.min(expected.length, k);
}

/**
 * Reciprocal rank of the first relevant hit. Returns 0 if none of the
 * expected ids appear in `returned`.
 */
export function reciprocalRank(
  expected: readonly string[],
  returned: readonly string[],
): number {
  const expSet = new Set(expected);
  for (let i = 0; i < returned.length; i++) {
    if (expSet.has(returned[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * nDCG@k with binary relevance. Upper-bounded at 1.0, 0 when no hits.
 */
export function ndcgAtK(
  expected: readonly string[],
  returned: readonly string[],
  k = 10,
): number {
  const expSet = new Set(expected);
  const topK = returned.slice(0, k);

  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (expSet.has(topK[i])) dcg += 1 / Math.log2(i + 2);
  }

  let idcg = 0;
  const idealHits = Math.min(expected.length, k);
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);

  return idcg === 0 ? 0 : dcg / idcg;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  const fraction = rank - low;
  return sorted[low]! * (1 - fraction) + sorted[high]! * fraction;
}
