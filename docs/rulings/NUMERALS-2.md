# NUMERALS-2

> Section: 2026-10-07 — Builder publish reaches the storefront + Western digits by default (branch `fix/builder-publish-and-digits`)

Ruling NUMERALS-2 — EGP display drops an all-zero fraction (`450 ج.م`, `EGP 450`) and keeps every decimal when there are piastres (`450.50 ج.م`), on customer-facing output (storefront, emails, invoices, wa.me messages). The admin and the orders app keep fixed decimals (`fixedDecimals: true` in the admin's formatPrice and every admin `formatMoney`; the orders app's own formatter is unchanged): they are accounting surfaces where a column of `450.00 / 12.50` reads better aligned, and the brief scoped the rule to customer output. Machine-readable values (JSON-LD, llms.txt, CSV, inputs) keep `minorToDecimalString`. Cost if wrong: one more call-site flag to flip if Ahmad wants the admin trimmed too.
