# ADM-GREY-1

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling ADM-GREY-1 — no raw neutral palette in admin or orders; `muted-ink` for text on a solid
`bg-muted` (issue 2372).** `text-gray-900` etc. do not follow the theme: in dark mode the SMS
queue's primary column measured ~1:1 on the card. Every raw `text|bg|border|divide|…-(gray|slate|
zinc|neutral|stone)-N` in `apps/admin` (15 files) was replaced with semantic tokens, and the
contrast gate (`tests/unit/admin-tint-ink-contrast.test.ts`) now bans the form outright; gradient
stops are exempt (theme-preview swatches). `--muted-ink` (light 5.63:1, dark 6.66:1 on `bg-muted`)
is the grey-pill text, because `muted-foreground` is 4.32:1 on a solid `bg-muted` in light. The 74
PRE-EXISTING `bg-muted … text-muted-foreground` pairs elsewhere in admin were not rewritten here and
are not gated yet (4.32:1, a marginal AA miss in light only; fine in dark). Cost if wrong: grey
secondary text on those pills stays just under AA in the light theme.
