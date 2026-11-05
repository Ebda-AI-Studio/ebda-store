# PREMIUM-22

> Section: 2026-11-03 - Storefront premium defaults (PREMIUM-\*)

Ruling PREMIUM-22 - a short page ends its footer above the bottom bar; the cookie strip sits on the bottom layer. the shop wrapper's min-height is `100dvh - --chrome-reserve` (8rem with the tab bar, 0 with `data-tab-bar=off`, +4.25rem/+5.75rem with a sticky task bar), the same numbers as the body padding, so a short page's footer is not parked under the tab bar. The cookie strip lifts by whatever bottom bar exists (`html[data-task-bar]` -> `--sticky-bar-h`, `html[data-tab-bar=off]` -> safe area). C-04 holds: still one fixed bottom layer besides the one-time consent dialog. Evidence: `fixed-bottom-single-layer.test.ts`. Not measured live (no local stack): `npm run test:fixed-bars` needs a built storefront. Cost if wrong: a skin with a taller tab bar needs its own `--bottom-tab-h`, which it already must set.
