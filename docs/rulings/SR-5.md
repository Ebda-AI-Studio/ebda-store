# SR-5

> Section: 2026-09-16

**Ruling SR-5 — 8 of the 11 store-resolving pages keep the chrome-less root
boundary.** Only `/products`, `/products/[slug]` and `/bundles/[slug]` have a
segment boundary that wraps the fallback in `ShopChrome`; the homepage,
`/categories`, `/bundles`, `/blog/[slug]`, `/about`, `/contact`, `/faq`,
`/how-to-guides` and `/locations` fall through to the root boundary and render
without header/nav/footer. The retry COPY — the deliverable of this work — is
correct on all 11; only the chrome differs, and that gap predates this change.
Adding 8 boundaries is a presentation change outside today's approved scope.
Cost if wrong: a shopper who hits a transient on the homepage sees a bare
centered retry card instead of the branded storefront chrome, which reads as
more broken than it is.
