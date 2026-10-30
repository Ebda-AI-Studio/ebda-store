/** Wilson score interval for a proportion (z = 1.96, 95%). Pure. */
export const WILSON_Z = 1.96;

function wilson(hit: number, n: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = hit / n;
  const z2 = WILSON_Z * WILSON_Z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}
export const wilsonLower = (hit: number, n: number) => wilson(hit, n).lower;
export const wilsonUpper = (hit: number, n: number) => wilson(hit, n).upper;
