# YWA-TXT-1

> Section: Backlog batch y-web-admin (2026-10-01)

**Ruling YWA-TXT-1 — role-coloured text is `-ink` everywhere in admin and orders; the storefront gets
only the dropped-class ban; bare `text-primary` links stay (issues 2332, 2341, 2342, 2349).**
Owner approval 2026-10-01: admin colour changes are approved, including the orders app. Done: 232
bare `text-{success,warning,info,destructive}` class strings in admin and 29 in orders (plus 4
`bg-primary/N text-primary` pills in orders) now read `text-<role>-ink`; orders gained the five
`-ink` tokens (light + dark, the admin values) and the tailwind `ink` keys. The gate runs over both
apps from each app's own globals.css, per theme and per state — rest, and `hover:` tint (the
state YWA-1 left out) — at 4.5:1 for text and 3:1 for an icon (a fixed `h-*`+`w-*` box; 21
admin icons keep the role colour because they clear 3:1). Its dropped-class half (double and
off-scale opacity modifiers) also runs over `apps/web` and `packages/ui`: the two storefront
offenders (`elegant/Hero.tsx` ring, `modern/CategoryCard.tsx` via-stop at opacity 8) were REMOVED,
not re-stepped — a compiled probe against apps/web's own Tailwind 3.4.19 config emits no rule for
either, so removing them is pixel-identical on every store, demo-store included, while stepping them
to `/10` would be a visible change. NOT done, and why: (1) bare `text-primary` on the plain surface
and under `hover:bg-primary/N` — it is the brand orange on every admin link (2.5–2.9:1 on white);
re-colouring it changes the whole admin's link colour, an owner call. (2) The storefront's tint and
bare-text shapes (issue 2349's apps/web half: cart/checkout/auth banners, 59 strings) — those pages
render on demo-store, whose look must not change; it needs either an owner OK or a default-off theme
flag with demo-store pinned by data. Cost if wrong: admin links stay below AA; a shopper on the
storefront reads checkout errors at 2–3.3:1 until the storefront decision is made.
