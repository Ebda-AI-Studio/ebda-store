# SEARCH-LIVE-1

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling SEARCH-LIVE-1 (Ahmad 2026-10-26, controller brief) — every Ebda search box shows results while typing, from the 1st character (one Arabic letter is a word), after a 150 ms debounce, through ONE shared behaviour in `@ebda/ui` (`useLiveSearch`: abort the superseded request AND expose only results that answer the current query; `useListboxNav`: ARIA combobox + Arrow/Home/End/Enter/Escape; `highlightSegments`: matched text marked through `normalizeArabicSearch`, rendered as text nodes). Spec and surface list: `docs/plans/done/2026-10-26-search-as-you-type.md`. Storefront header `SearchAutocomplete` is the first adopter: it now turns the parent's input into a combobox itself (no template forwards keys), so Arrow keys work from the input. Cost if wrong: an extra request per 150 ms of typing on one store (cached per term, edge-cached 120 s, rate limited).
