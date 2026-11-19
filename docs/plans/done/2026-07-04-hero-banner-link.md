# Hero banner links — make hero slides pressable (marketing space)

**Date:** 2026-07-04 · **Scope:** add an optional per-slide "banner link" so a merchant can turn a hero slide into a clickable marketing banner. Empty link = current behavior (non-clickable).

## Approach (approved)

Stretched-link pattern: when a slide has a banner link, the whole slide is clickable → banner link; the existing per-slide CTA button stays its own link on top (its click wins). No nested `<a>`.

## Data

- `packages/shared/src/types/store-layout.ts` — add `link?: string` to `HeroSlide` (single, non-bilingual, mirroring `ctaHref`).
- `apps/api/src/routes/store-layout.routes.ts` `heroSlideSchema` — add `link` with the **exact** refine `ctaHref` uses: `.string().optional().refine(v => v === undefined || v === '' || isSafeUrl(v), {...})`. Without listing it in the Zod object the save silently strips it (the documented mobile-image silent-strip trap).

## Admin (Page Builder hero editor)

Add a "Banner link" text input to the hero-slide editor next to the CTA fields (find where `ctaHref`/`ctaText` are edited in the page-builder hero section component). Optional; placeholder: `https://… or /products — leave empty for a non-clickable banner`. Bilingual label (EN/AR i18n keys, path-parity).

## Storefront — shared wrapper (DRY across 5 themes)

New `apps/web/src/templates/shared/HeroBannerLink.tsx` (or a small helper) used by all 5 theme `Hero.tsx`:

- Input: the slide's `link`, plus children (the slide content).
- If `link` is empty/unsafe → render children as-is (a Fragment), **no wrapper, zero behavior change**.
- If set → wrap so an absolutely-positioned `<a href={sanitizeUrl(link)}>` covers the whole slide (`absolute inset-0 z-0`), with an `aria-label` from the slide headline/alt for a11y; the CTA `<Link>` in each theme gets `relative z-10` so it sits above and its click wins.
- `sanitizeUrl(link)` (same helper the themes already use for `ctaLink`) as client-side defense-in-depth; resolve relative paths through the existing `urlPrefix` logic like `ctaLink`.
- Respect `target`/`rel`: external (http) links get `rel="noopener"`; keep same-tab by default (marketing redirect).

Apply to: `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/Hero.tsx` — thread the slide `link` into the wrapper, add `relative z-10` to each theme's CTA button. Layouts differ (full-bleed vs split column) but `absolute inset-0` stretched link works for both.

## Security

Server `isSafeUrl` (reused) + client `sanitizeUrl` (reused). Identical guarantees to `ctaHref` — `javascript:`/`data:` rejected on save AND neutralized on render. No new surface.

## Blast-radius (sweep before "done", per Rule D-GATE)

`HeroSlide` consumers: 5 theme Hero.tsx (render), heroSlideSchema (save), the admin hero editor (edit), layout baselines / demo-store data (`template-baselines.ts`, `clone-demo-stores`/seed if they build slides), the storefront layout type in `apps/web` if it re-declares HeroSlide. Grep `link` usage won't be unique — grep `HeroSlide` + `ctaHref` (the sibling field) as the anchor and mirror every site.

## Testing

- Unit: `heroSlideSchema` accepts empty/safe `link`, rejects `javascript:`; the wrapper renders an `<a>` when link set and a Fragment when empty.
- Manual/UAT: set a banner link on a demo slide → click image redirects; click CTA → CTA target; clear link → non-clickable.

## Rollout

Single PR → CI → merge. No behavior change for existing stores (link defaults empty → renders exactly as today). Platform-level (all themes), no tenant branching.
