/**
 * Numerically-stable softmax over a vector of scores.
 *
 * Subtracts the max before exponentiating so large raw scores can't overflow.
 * `temperature` controls sharpness: small T approaches a one-hot argmax, larger T
 * flattens toward uniform. Unlike sum-normalization it handles **negative** scores
 * gracefully (via `exp`), which is why the heuristic classifier uses it — its
 * cross-validation penalties push some raw class scores below zero.
 *
 * Returns a distribution that sums to 1 (uniform when every score is equal).
 */
export function softmax(scores: number[], temperature = 1): number[] {
  if (scores.length === 0) return [];
  const t = temperature > 0 ? temperature : 1;
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / t));
  const sum = exps.reduce((a, b) => a + b, 0);
  return sum > 0
    ? exps.map((e) => e / sum)
    : exps.map(() => 1 / scores.length);
}
