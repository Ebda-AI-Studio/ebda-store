/**
 * Reciprocal rank fusion (Cormack, Clarke & Buettcher 2009), k = 60. Each list adds
 * 1 / (k + rank) to an id's score; ties break by id so the order is deterministic (stable paging).
 */
export function rrfFuse(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists)
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
}

/**
 * Storefront relevance order (plan amendment E10): fuse the first `head` keyword ids with the
 * vector ids, then append the rest of the keyword ids in their own (similarity) order. Every
 * keyword match stays reachable by paging; a vector hit that sat in the keyword tail moves up
 * into the fused head once. With no vector ids the result is exactly the keyword order.
 */
export function hybridOrder(lexical: string[], vector: string[], head: number): string[] {
  if (vector.length === 0) return [...lexical];
  const fused = rrfFuse([lexical.slice(0, head), vector]);
  const seen = new Set(fused);
  return [...fused, ...lexical.slice(head).filter(id => !seen.has(id))];
}
