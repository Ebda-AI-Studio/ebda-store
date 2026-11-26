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

Update 2026-11-11 (W2 token sync): the values no longer live in the admin. `apps/admin/src/components/ui/tokens.ts` maps the vendored foundation
tokens (`@ebda/shared/design`, ebda-foundation design language v1) to Tailwind classes; `globals.css` imports the vendored `tokens.css` and derives
`--radius` and the motion variables from it; the guard rules G1-G6 are the vendored `guards.ts`. `tests/unit/admin-design-tokens-sync.test.ts`
fails when a class, an RTL leading or a variable stops equalling the foundation value, when a role colour turns orange, or when a second font
family is loaded. Ruling ADM-DS-2 - brand.ts stays held at the previously locked copy (`foundation.lock.json` `held`): foundation #40 changed the
legal names and removed `company.foundedOn`, which marketing reads. Cost if wrong: the Store keeps the old legal-name copy until the separate brand PR lands.
