/**
 * Per-isolate memo of the cache generations an edge-cache HIT is validated against (Ruling NZ-D3, NEON-SCALE-1 rule 4).
 *
 * Without it every anonymous storefront hit reads the generation Durable Object(s); with it one isolate reads a given set of
 * names at most once per 2 s, however many hits it serves. Applies ONLY to validating a stored copy. A fill still takes its
 * snapshot fresh (`captureEdgeSnapshot`) and the fill-race guard in public-cache reads fresh, so the memo can only make a hit
 * look valid for longer, never make a stale fill look fresh.
 *
 * STALENESS CLASS: BOUNDED, residual <= 2 s per data-centre isolate (a price / stock figure on a read-only listing; checkout,
 * cart and order read price and stock authoritatively from the StoreDO). A write in THIS isolate drops the memo at once
 * (`dropEdgeGensMemo`, called by every generation bump), so the isolate that took the write never serves its own stale copy.
 * Cost if wrong: a shopper sees an old listing price for <= 2 s; the charged price is always current.
 */
export const EDGE_GENS_MEMO_MS = 2000;
const MAX_ENTRIES = 5000;

interface Slot {
  at: number;
  value: Promise<string[] | null>;
}
const memo = new Map<string, Slot>();

export function dropEdgeGensMemo(): void {
  memo.clear();
}

export function memoisedGens(
  names: string[],
  read: (names: string[]) => Promise<string[] | null>,
  now: number = Date.now()
): Promise<string[] | null> {
  const key = names.join('\u0000');
  const hit = memo.get(key);
  if (hit && now - hit.at < EDGE_GENS_MEMO_MS) return hit.value;
  if (memo.size >= MAX_ENTRIES) memo.clear();
  const value = read(names);
  const slot: Slot = { at: now, value };
  memo.set(key, slot);
  // an unverifiable answer (null) or a throw is never remembered: the next hit asks again
  void value.then(
    v => v === null && memo.get(key) === slot && memo.delete(key),
    () => memo.get(key) === slot && memo.delete(key)
  );
  return value;
}
