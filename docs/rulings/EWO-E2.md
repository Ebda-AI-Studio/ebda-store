# EWO-E2

> Section: Cluster E — middleware, headers, static assets

**Ruling EWO-E2 — #2091: `x-is-platform` is a tri-state; custom domains now assert `false`.**
`layout.tsx` reads it through `isPlatformFromHeader` (absent → `undefined`), and `handleCustomDomain`
sets `'false'` explicitly, so ABSENT means only "middleware did not run", which is when
StoreProvider's client-side `isPlatformHost()` fallback must run. SSR output is unchanged for both
host classes. This makes the 2026-09-25 "falls back when the header is absent" ruling true.
Cost if wrong: none for rendered HTML — both host classes seed the same value as before.
