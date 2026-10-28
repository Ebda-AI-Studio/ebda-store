# DAHAB-5

> Section: 2026-10-07 — Dahab template, builder Phase 3 pilot (branch `feat/template-dahab`)

Ruling DAHAB-5 — two platform defects found by the pilot are fixed for every store: (a) `GET /public/stores/:id/testimonials` read `reviews`/`users` with no tenant context, so under strict RLS it returned [] and no store's testimonials section ever rendered — now `readInStoreContext` (`tests/integration/public-testimonials-rls.test.ts`; mutant "drop the store scope" → 2 red); (b) the mobile bottom-bar menu sheet was `aria-hidden` but its links stayed keyboard-focusable while closed (axe `aria-hidden-focus`) — now `inert` when closed. Cost if wrong: none expected; (a) exposes only published, verified reviews of the path's store.
