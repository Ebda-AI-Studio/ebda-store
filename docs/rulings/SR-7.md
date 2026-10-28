# SR-7

> Section: 2026-09-16

**Ruling SR-7 — the transient fallback is flagged, so the retry page is no
longer TITLED "Page not found".** Review found that during the exact scenario
this work serves, the layout's lenient `getStore()` returns `DEFAULT_STORE`
(`id:'demo'`) and `generateMetadata` hits that sentinel, emitting
`title: 'Page not found — Ebda AI Studio'` around the new retry body — the removed
claim, relocated from the body to the `<title>`, where it reaches the tab,
bookmarks and link previews. `lenientResolve` now reports WHICH `null` it
produced, `getStore()` returns a `transientResolveFailure`-flagged fallback,
and the layout emits store-neutral "Temporarily unavailable" metadata with
`robots: noindex` for it. Two residuals are accepted, not fixed: the retry page
still paints with `DEFAULT_THEME` and the "Force" name, because during a
transient the merchant's brand is genuinely unknown and inventing one is worse;
and SR-4's "no noindex" refers to the BODY — the layout's metadata does emit a
head-level `robots: noindex` on this path, which is the correct place for it.
Cost if wrong: a crawler that fetched the retry page at 500 sees a neutral
title instead of the merchant's, which is the intended trade.

**CORRECTION to SR-7 (same day, next review pass).** An earlier version of this
ruling rebutted a reported dead `/demo` "Go Home" link by concluding "the link
is `/`" — technically right and materially wrong, because `/` is not the
merchant's home on the platform host. Measured: `curl -sI
https://store.ebda.app/` returns `307 → https://ebda.app`. So on a
path-based store the retry page's only non-retry control walked a merchant's
shopper onto the Force platform pitch — the HARD multi-tenant rule in
`app/not-found.tsx`. The link is now suppressed on the transient branch
entirely: during a transient there is no known home to offer, and "Try Again"
is the correct action. Custom-domain stores were never affected. This is the
second time a narrow rebuttal hid a wider defect — rebut the MECHANISM, not the
sentence.

**Scope correction to SR-7 — which routes the new title actually reaches.** In
Next's metadata merge a page's own export wins over the layout's, and nearly
every store-resolving route defines a title: `products/page.tsx` exports static
`title: 'Products'`, `products/[slug]` and `bundles/[slug]` return
`{title:'Product'}`/`{title:'Bundle'}` from their own demo-sentinel branch, and
categories/about/contact/locations/bundles/faq/how-to-guides all export static
metadata. So the layout's "Temporarily unavailable" title is visible chiefly on
the HOMEPAGE — which is also the only route where the old "Page not found —
Ebda AI Studio" title was ever visible, so the bug and the fix have the same reach.
The `robots: noindex` half DOES inherit on every route. Extending the title to
the PLP/PDP means touching each page's own metadata export and is deliberately
not done here.
