/**
 * A ratio or average over a count that can be zero is UNKNOWN there, not zero: "avg position 0.0" over
 * 0 impressions reads as the best possible rank, "0% CTR" as a failure. Callers render `null` as "—".
 */
export function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 && Number.isFinite(numerator / denominator)
    ? numerator / denominator
    : null;
}
