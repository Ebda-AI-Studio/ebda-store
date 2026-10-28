# R-EBDA-COPY-3

> Section: 2026-10-07 — Marketing copy and design (R-EBDA-COPY-\*)

Ruling R-EBDA-COPY-3 (superseded 2026-10-14 by MKT-1: the hero poster and `hero-poster.ts` were removed with the Nile-at-night hero) — the hero poster is an inline SVG (`src/lib/hero-poster.ts`), not a CSS background image. Evidence: as a `url()` background it became the LCP element (4.6s on the uncompressed local server); inline SVG shapes are not LCP candidates, so the headline text is. Cost if wrong: ~24 KB (~4 KB brotli) more HTML per home page.
