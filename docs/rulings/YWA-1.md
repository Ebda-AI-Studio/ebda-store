# YWA-1

> Section: Backlog batch y-web-admin (2026-10-01)

**Ruling YWA-1: the tinted-pill gate measures resolved pairs per theme. Bare role text on a plain
surface and `hover:` tints stay outside it (issues 2313 / 2322 / 2323, follow-up issue 2332).**
`tests/unit/admin-tint-ink-contrast.test.ts` now works out, for each class string, which tint
alpha (up to 40%) and which text class apply in light and in `dark:`. It then measures that pair
from globals.css. It also bans two spellings that the check could not see or that Tailwind 3
silently drops: arbitrary-value role colours (`bg-[hsl(var(--success))]/10`) and off-scale or
double opacity modifiers (`/30/30`, `/8`). The compiled probe emitted no rule for either
`bg-destructive/30/30` or `bg-primary/8`. As a result, the sidebar's active item
(`bg-primary/8 text-primary`) had no tint at all, and it now renders `bg-primary/10
text-primary-ink`. The gate does not measure two shapes:

- `text-<role>` on a plain surface: 243 uses, measured on white at success 3.05, warning 1.80,
  info 3.81 and destructive 4.38 to 1.
- `hover:bg-<role>/N` under bare text: 66 strings.

Converting those changes the resting look of most admin screens, not just the pills. Issue 2332
tracks them. The storefront has the same shapes and is excluded, because storefront visual changes
need owner sign-off. Cost if wrong: warning-coloured admin text stays at 1.8:1 until issue 2332
lands. **Superseded by YWA-TXT-1 (issue 2332 landed).**
