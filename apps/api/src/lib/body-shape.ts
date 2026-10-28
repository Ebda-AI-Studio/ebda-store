/**
 * Shape limits for a parsed JSON body, checked BEFORE any schema parses it.
 *
 * Why (Ruling ITEST-11, GHSA-mrhx-c7xc-m3w5): a schema parser builds one issue object per failing array
 * element. Measured on zod 4.6.7 with 1,000,000 elements that all fail `z.array(z.string())`:
 *   - `zod` (v4), no `.max()`        276 ms, 1,000,000 issues, +471 MB heap
 *   - `zod` (v4), `.max(100)`          0 ms, 1 issue, +0 MB      (the 4.6.6 patch: size cap checked first)
 *   - `zod/v3`, no `.max()`          684 ms, 1,000,000 issues, +311 MB
 *   - `zod/v3`, `.max(100)`          476 ms, 1,000,001 issues, +307 MB  (the v3 entry point is NOT patched)
 * Our code imports `zod/v3`, so a declared `.max()` does not stop the work there; the cap has to be in front.
 */
export interface BodyShapeLimits {
  maxArrayLength: number;
  maxDepth: number;
  maxNodes: number;
}

/** First limit a parsed JSON value exceeds, or null. Iterative: a hostile depth cannot blow the stack. */
export function bodyShapeViolation(body: unknown, limits: BodyShapeLimits): string | null {
  const stack: Array<{ v: unknown; d: number }> = [{ v: body, d: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (d > limits.maxDepth) return 'nested too deeply';
    if (++nodes > limits.maxNodes) return 'too many fields';
    if (Array.isArray(v)) {
      if (v.length > limits.maxArrayLength) return 'array too long';
      for (const x of v) stack.push({ v: x, d: d + 1 });
    } else {
      for (const x of Object.values(v as Record<string, unknown>)) stack.push({ v: x, d: d + 1 });
    }
  }
  return null;
}
