# TAX-1a

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling TAX-1a — the tax surface offers only what the charge reads, on every plan (issues 2357,
2358; amends TAX-1).** The charge reads `taxEnabled`, `taxIncludedInPrice` and the sum of the
active rates, nothing else. The admin tax page no longer offers a rate's country/state, priority or
compound flag, nor the store's "default tax rate" (whose own help text still claimed the
highest-priority rate is charged); the info box now states the sum rule and shows the combined
rate being charged. `tax.routes.ts` rejects those keys with a 400 (`.strict()` Zod) instead of
storing values nothing reads — a merchant who entered "KW 5%" and "SA 15%" had every order charged
20%. The columns stay in the schema (stored values are harmless, never read). Every tax route and
the admin page are no longer behind `requireFeature('tax')`: collection is gated on `taxEnabled`
alone, so the switch that turns it off and the list that sets what it charges answer on every
plan, including a store that lapsed to `free`. The `tax` feature key is kept, re-described as
reserved for advanced tax features (region-scoped or compound rates); none is built, so today it
gates nothing — a super-admin toggling it changes nothing. Cost if wrong: a merchant who needs a
region-specific or compound rate has no way to express it until that advanced feature is built
(production has 0 `tax_rates` rows, so no configured rate is affected).
