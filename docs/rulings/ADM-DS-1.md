# Ruling ADM-DS-1 - one admin design system (tokens, nav, guard)

Date: 2026-11-11. Source: the 2026-11-11 admin UI/UX audit (local: business/ebda/audits/2026-11-11-admin-ui-ux-audit.md).

Ruling ADM-DS-1 - the merchant admin takes type, radii, control + nav heights, elevation, motion and z-index from
`apps/admin/src/components/ui/tokens.ts`; colours come from the CSS variables in `styles/globals.css`. Every navigation item
(sidebar, hub tab, settings rail, bottom bar) takes its classes from `navItemClasses()` / `bottomNavClasses()` with ONE active
language (`bg-primary/15 text-primary-ink`). `tests/unit/admin-design-tokens.test.ts` fails on raw palette colours, hex literals,
`text-[Npx]`, bare `rounded`, letter-spacing (Arabic joining) and self-styled `data-ui="nav"` items; pages not yet migrated sit in a
per-file baseline that may only shrink (waves W2/W3), and an empty baseline is the exit gate.
Evidence: nav heights 36/44/48 with filled vs tinted active states; 310 raw-palette classes in 57 files; gold `text-primary` at 3.09:1.
Cost if wrong: a tokens change touches every nav item at once, so a bad value ships everywhere in one deploy; the unit test and the
visual script (scripts/visual/admin-button-styles.mjs) are the net, and rollback is reverting one file.

Wave plan and the canonical scale: the audit's "Design system v1" section. Admin Button scale stays as ADM-BTN-1.
