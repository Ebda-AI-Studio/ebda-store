/**
 * STORE-QA-50: category / tag / sort live in the query string so the back button works and a filtered list can be
 * shared. Returns the relative URL to `replaceState` to (every other param, the path and the hash kept as they were),
 * or null when the address bar already says the same thing.
 */
export function filterUrlSync(
  currentHref: string,
  state: { category: string; tag: string; sort: string }
): string | null {
  const url = new URL(currentHref);
  const set = (k: string, v: string | null) =>
    v ? url.searchParams.set(k, v) : url.searchParams.delete(k);
  set('category', state.category || null);
  set('tag', state.tag || null);
  set('sort', state.sort && state.sort !== 'default' ? state.sort : null);
  const next = url.pathname + url.search + url.hash;
  const here = new URL(currentHref);
  return next === here.pathname + here.search + here.hash ? null : next;
}
