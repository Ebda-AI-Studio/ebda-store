# TAX-5

> Section: 2026-10-07 — Egypt VAT gate, phase 1 (branch `feat/vat-gate`; design `docs/plans/done/2026-10-07-egypt-vat-and-eta.md`)

Ruling TAX-5 — the TRN is validated for shape only (9 digits after stripping spaces/dashes/dots and folding Arabic-Indic digits); whether it is REAL is the super-admin's manual review (design tier T3; the e-finance TIN OTP service is open question Q2). No uniqueness constraint: one legal entity may own several Ebda stores (Business plan allows 3), so the review queue instead shows how many OTHER stores hold the same TRN in pending/verified (`duplicate_trn_stores`). Cost if wrong: if some valid Egyptian registration numbers are not 9 digits, those merchants are refused at the form and must contact support; the regex is one line in `packages/shared/src/tax-profile.ts`.
