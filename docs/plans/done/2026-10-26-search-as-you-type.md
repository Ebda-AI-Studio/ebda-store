# Search as you type, everywhere (2026-10-26)

Finish line: every Ebda search box shows results while typing, from the first character
(one Arabic letter is a word), with one shared behaviour. Must NOT change: ranking, the
SEARCH-URL-1 rule (terms travel in the X-Search-Query header, never the URL), tenant scoping.

## Audit (what exists)

| Surface                                                                                                                                                   | Today                                                                                                        | Gap                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Storefront header (all 10 templates; 6 own a Header, souq/lamma/qamar/jasmine reuse minimal)                                                              | `SearchAutocomplete`: 200 ms, 1 char, `/public/:store/search/suggest`, ref-guard for stale                   | no AbortController, input is not a combobox (no role/aria-activedescendant, arrows do nothing from the input), no highlight |
| Storefront `/search`, products sidebar                                                                                                                    | 300 ms live                                                                                                  | 300 ms, no abort                                                                                                            |
| Admin lists via `SearchInput` (customers, products, affiliates, categories, blog, reviews, suppliers, adjustments, purchase orders, warehouse, inventory) | 300 ms live                                                                                                  | 300 ms, stale guarded per page only                                                                                         |
| Admin submit-only: stores, users, redirects, coupons (Enter), bulk export                                                                                 | submit / Enter                                                                                               | not live                                                                                                                    |
| Admin pickers: orders/new product + customer, BundleItemPicker                                                                                            | 250 ms but needs 2 chars                                                                                     | 1 Arabic letter finds nothing, no combobox ARIA                                                                             |
| Admin ScopePicker, SettingsSearch                                                                                                                         | live (300 ms / sync)                                                                                         | ARIA, abort                                                                                                                 |
| Orders PWA `/orders`                                                                                                                                      | 300 ms, server side                                                                                          | no abort                                                                                                                    |
| help / docs                                                                                                                                               | header box submits to `/search/`; results page is live (MiniSearch, one JSON, both locales filtered by lang) | no dropdown on the header box                                                                                               |
| marketing                                                                                                                                                 | phone-store demo search, client side, live                                                                   | none                                                                                                                        |

## Shared behaviour spec

1. Results from the 1st character. Trim, cap 100 chars. Debounce 150 ms (cached terms are instant).
2. Latest wins: every request gets an AbortController; the previous one is aborted; results carry the
   query they answer and are shown only when it equals the current trimmed query (never an older one).
3. ARIA combobox: input `role=combobox aria-autocomplete=list aria-expanded aria-controls aria-activedescendant`;
   popup `role=listbox`, options `role=option` with ids; live region (`role=status`) announces count.
   Keys: Down/Up wrap, Home/End, Enter picks active (else submits the form), Esc closes, Tab closes.
4. RTL via logical properties only; popup `inset-inline`; options text-start.
5. Highlight with `normalizeArabicSearch` folding (alef/yeh/teh-marbuta/diacritics), mapped back to the
   original characters; never innerHTML (React text nodes / textContent).
6. States: loading (spinner row, `aria-busy`), empty, error, all in Egyptian Arabic + English; popup reserves
   no layout (absolute), spinner is static under `prefers-reduced-motion`.
7. Mobile: 16px input font (no iOS zoom), options >= 44px tall, popup max-height 70vh.

## Shared code

`packages/ui/src/search/` (React; used by web + admin): `useLiveSearch`, `highlightSegments`,
`useListboxNav`. Orders PWA reuses the hook by relative import of the same file only if it
already depends on `@ebda/ui`; otherwise it keeps its inline debounce and only gains AbortController.
Help/docs are static: vanilla combobox in `packages/site-kit/src/client/` (esbuild bundle), same spec.

## Static index (help/docs)

Keep MiniSearch (already shipped, Arabic-normalised via `search-core`, prefix + fuzzy). Pagefind rejected
unless it beats it: it needs a second WASM runtime, its Arabic stemming is weaker than the fold we already
use, and the index is split per language. Gate: `search-index.json` gzip per locale < 150 KB; measure in
the build and fail `search-check` above it. The index has both locales in one file, so split it per
locale so each page loads only its own.

## PRs (one branch each, from main)

1. `@ebda/ui` search primitives + storefront `SearchAutocomplete` (abort, combobox ARIA, highlight, 150 ms).
2. Admin: `SearchInput` 150 ms + abort-safe, live stores/users/redirects/coupons/bulk, pickers from 1 char with combobox ARIA.
3. Orders PWA: abort + combobox/status semantics.
4. help + docs: header dropdown, per-locale index, size gate.

## Tests

Unit: debounce, abort-stale ordering (slow-old resolves after fast-new), keyboard, ARIA wiring, highlight
(Arabic folding). Playwright per surface where the harness runs it; axe on the open popup. API typeahead
p95 < 300 ms (existing integration test keeps the budget).
