# Storefront premium defaults (audit 2026-11-03)

Source: `Ebda-AI-Studio/business/ebda/audits/2026-11-03-storefront-templates-audit.md`. Goal: a merchant with ordinary content and few photos still gets a beautiful store. Rulings PREMIUM-1..5 (`docs/rulings/`).

Finish line: every (a) item, (b) per-template finding, (c) default and (d) win either fixed with a test or listed with a reason. Must not change: merchant colours as data, existing look tokens, card CTA/OOS system. Evidence: vitest (contrast matrix, srcset paths, hero scale, grid fill), tsc, and before/after screenshots of the 15 looks at 390 and 1440.

Branch 1 (this one): P0s + hero/rhythm/fallbacks + image pipeline.

1.  Tone contract (`section-ink.ts`, #1) 2. Image variants at upload + backfill + sizes + loader (#2) 3. Hero scale + pause (#3) 4. Grid/carousel rhythm (#4) 5. MissingImage (#5)
    Branch 2: chrome and states (white-label lockup on checkout/404, Arabic tracking guard, numerals, duplicate CTAs/OOS PDP, tab bar, header/lockup clipping, cookie banner, empty states, 401 noise).
    Branch 3: listing/PDP/templates (filters, PDP trust + compare-at, Dahab/Souq/Lamma fixes, blog SSR, story block, view-all).
