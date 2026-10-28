# EWO-E3

> Section: Cluster E — middleware, headers, static assets

**Ruling EWO-E3 — `/manifest.webmanifest` runs through middleware again (found while sweeping
#2153 / #1731's matcher class).** Excluded since 2026-03-16 "so it is not treated as a store slug";
`extractStoreSlug` has skipped dotted segments since, and the exclusion meant `app/manifest.ts` never
saw `x-store-domain`: `curl https://demo-store.example/manifest.webmanifest` on 2026-10-01 returned
`{"name":"Force",…,"theme_color":"#ff6e00"}` — every custom-domain merchant's install prompt showed
the platform identity. Cost if wrong: the manifest now does one extra middleware pass per install
check; no rewrite applies to it (pinned by tests).
