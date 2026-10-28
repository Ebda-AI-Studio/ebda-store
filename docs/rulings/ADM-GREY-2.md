# ADM-GREY-2

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling ADM-GREY-2 — the contrast gate scopes by render surface; raw palette text on a themed
surface is banned (issues 2380, 2381).** `@ebda/ui` was exempt as a directory, yet admin compiles
it and renders `<Label>` (text-gray-700: ~1.8:1 on the dark card) on six surfaces. The gate now
runs the full admin/orders checks over every ui component that app imports, with that app's tokens.
It found three more: the error line of `Input`, `Select`, `Textarea` (`text-destructive`, 4.38:1
light / 3.72:1 dark on the admin card) — now `text-destructive-ink`. Storefront stays
pixel-identical (Ruling YWA-TXT-1): apps/web renders no `Label`, and its tailwind config maps
`destructive.ink` to the SAME `hsl(var(--destructive))` declaration (per-store overrides included)
and safelists `text-gray-700`, so the compiled storefront CSS only gains one rule. Proven by a
screenshot diff of six live demo-store pages (home, product, cart, checkout; ar + en) with the ui
form error states injected, 390px + 1280px, light + dark: 0 differing pixels in 24/24 pairs, with
a positive control (a recoloured ink rule) differing in 24/24. The bank-reconciliation panel's
`bg-white`→`bg-card` regression (green-800 on the dark card, 2.66:1) and the whole panel, plus the
expense and purchase-order status maps, moved to role `-ink` pairs. Residual: ~186 admin/orders
class strings carry raw chromatic text (`text-red-600`, …) with no background in the same string;
their surface is inherited, so a static gate cannot tell a light-tint parent from the themed card —
not gated, not rewritten here. Cost if wrong: some of those read below AA in the dark theme until
migrated.
