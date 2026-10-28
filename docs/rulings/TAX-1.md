# TAX-1

> Section: Backlog batch x-api (2026-10-01, branch `fix/backlog-x-api`)

**Ruling TAX-1 — VAT is charged on `Store.taxEnabled` alone, at the SUM of the active rates
(issues 2166, 2114; amends M3-9 and CL-11).** Collection is a legal obligation, not a plan feature:
`resolveActiveTaxRate` no longer reads the plan-derived `tax` feature, so a store that lapses to
`free` keeps collecting (the feature still gates the admin tax pages). Several active rates are
charged as their sum (5% + 2% → 7%, summed in hundredths so 0.1 + 0.2 = 0.3), and the storefront
label shows that same figure. `country`/`state`, `isCompound` and `TaxSettings.defaultTaxRate` are
still not read. Production has 0 `tax_rates` rows and `taxEnabled: false` on every live store
(M3-9), so nothing charged today changes. Cost if wrong: a merchant who configured a compound or
country-specific rate is charged the plain sum; a free-plan merchant cannot open the tax page to
switch VAT off (they can ask support, or upgrade).
