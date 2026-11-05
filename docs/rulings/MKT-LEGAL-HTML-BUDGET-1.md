# MKT-LEGAL-HTML-BUDGET-1

Ruling MKT-LEGAL-HTML-BUDGET-1 - the marketing page-weight budget gets per-page HTML overrides for `/terms` (22 KB) and `/merchant-agreement` (21.5 KB), measured at 21.3 KB and 20.9 KB gzip against the 20.5 KB default in CI run 40926583564. These are long legal texts; JS (191.2 KB) and CSS are unchanged, and the `/en/` twins already pass. Found on PR #341, which does not touch marketing; the job ran there only because `packages/shared` changed. Cost if wrong: two legal pages may grow ~1 KB before the gate fires again; no user-visible cost.
