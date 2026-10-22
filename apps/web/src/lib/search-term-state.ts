/**
 * Where the storefront search term lives (Ruling SEARCH-URL-1, launch blocker 31).
 *
 * A typed term is often a phone number, an email or a name. In a URL it lands in Cloudflare
 * request logs, in `Referer` headers to third parties and in every ad pixel's PageView, so the
 * storefront never puts it in one. The address stays `/search` (plus non-personal `category` /
 * `sort`); the term is kept
 *   - in the history entry's `state` (back, forward and refresh read it back; it is never sent
 *     anywhere), written with the native History API, which Next's app router supports;
 *   - for one navigation, in sessionStorage (`stash`/`take`): the header search box hands the
 *     term to the search page that way;
 *   - for a same-tab reload whose entry lost its state, in sessionStorage (`LAST`), restored
 *     only when the navigation type is `reload` or `back_forward`.
 * An old `/search?q=` link (bookmark, a message, a browser history entry) is still understood: it
 * is adopted once and the address bar is rewritten without it. That one request has already
 * reached the log; nothing later can undo it.
 *
 * Browser-only; every function is a no-op or returns '' on the server.
 */

export const SEARCH_TERM_STATE_KEY = 'ebdaSearchTerm';
/** Dispatched on `window` after the current entry's term changed without a navigation. */
export const SEARCH_TERM_EVENT = 'ebda:search-term';
const PENDING_KEY = 'ebda:search:pending';
const LAST_KEY = 'ebda:search:last';
const MAX_TERM = 100;
/** `/search`, `/search/`, and a tenant-prefixed `/<slug>/search` or `/<locale>/search`. */
const SEARCH_PATH_RE = /(^|\/)search\/?$/;

function clean(term: unknown): string {
  return typeof term === 'string' ? term.trim().slice(0, MAX_TERM) : '';
}

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The term of the current history entry ('' when it has none). */
export function readSearchTermFromHistory(): string {
  if (typeof window === 'undefined') return '';
  const state = window.history.state as Record<string, unknown> | null;
  return clean(state?.[SEARCH_TERM_STATE_KEY]);
}

/**
 * Make `url` (a path + non-personal query, NEVER the term) the current entry, carrying `term` in
 * its state. `push` adds an entry (a new search), `replace` rewrites the current one.
 */
export function commitSearchTerm(term: string, url: string, mode: 'push' | 'replace'): void {
  if (typeof window === 'undefined') return;
  const t = clean(term);
  const state = { ...(window.history.state ?? {}), [SEARCH_TERM_STATE_KEY]: t };
  if (mode === 'push') window.history.pushState(state, '', url);
  else window.history.replaceState(state, '', url);
  try {
    if (t) store()?.setItem(LAST_KEY, t);
    else store()?.removeItem(LAST_KEY);
  } catch {
    // storage full / blocked: history.state alone still serves back, forward and refresh
  }
}

/** Hand a term to the search page for the next navigation (the header search box). */
export function stashPendingSearchTerm(term: string): void {
  try {
    store()?.setItem(PENDING_KEY, clean(term));
  } catch {
    // blocked storage: the search page opens empty, the shopper types again
  }
}

/** The stashed term, once ('' when none). */
export function takePendingSearchTerm(): string {
  const s = store();
  if (!s) return '';
  try {
    const t = clean(s.getItem(PENDING_KEY));
    s.removeItem(PENDING_KEY);
    return t;
  } catch {
    return '';
  }
}

/**
 * An old `/search?q=<term>` address: move the term into history.state and rewrite the URL without
 * it (other params stay). Returns the term, or '' when there is none or this is not the search page.
 */
export function adoptLegacySearchQuery(): string {
  if (typeof window === 'undefined') return '';
  if (!SEARCH_PATH_RE.test(window.location.pathname)) return '';
  const params = new URLSearchParams(window.location.search);
  const term = clean(params.get('q'));
  if (!params.has('q')) return '';
  params.delete('q');
  const rest = params.toString();
  commitSearchTerm(term, window.location.pathname + (rest ? `?${rest}` : ''), 'replace');
  return term;
}

function navigationType(): string {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return nav?.type ?? '';
  } catch {
    return '';
  }
}

/**
 * The term the search page should show now: this entry's state, else an old `?q=` link, else the
 * header hand-off, else (reload / back-forward whose entry lost its state) the last term of this
 * tab. A fresh visit to `/search` is empty. Whatever is found is written into the entry so a
 * refresh finds it without the hand-off.
 */
export function resolveSearchTerm(): string {
  if (typeof window === 'undefined') return '';
  const fromState = readSearchTermFromHistory();
  if (fromState) return fromState;
  const legacy = adoptLegacySearchQuery();
  if (legacy) return legacy;
  const here = window.location.pathname + window.location.search;
  const pending = takePendingSearchTerm();
  if (pending) {
    commitSearchTerm(pending, here, 'replace');
    return pending;
  }
  if (['reload', 'back_forward'].includes(navigationType())) {
    try {
      const last = clean(store()?.getItem(LAST_KEY));
      if (last) {
        commitSearchTerm(last, here, 'replace');
        return last;
      }
    } catch {
      // ignore
    }
  }
  return '';
}

/**
 * Search from the header box. From another page: hand the term over and navigate to `/search`
 * (`navigate`). Already on the search page nothing navigates, so the entry is rewritten here and
 * the page is told through `SEARCH_TERM_EVENT`.
 */
export function openSearch(term: string, searchUrl: string, navigate: (url: string) => void): void {
  if (typeof window === 'undefined') return;
  const path = new URL(searchUrl, window.location.origin).pathname;
  if (window.location.pathname.replace(/\/$/, '') === path.replace(/\/$/, '')) {
    commitSearchTerm(term, searchUrl, 'push');
    window.dispatchEvent(new Event(SEARCH_TERM_EVENT));
    return;
  }
  stashPendingSearchTerm(term);
  navigate(searchUrl);
}
