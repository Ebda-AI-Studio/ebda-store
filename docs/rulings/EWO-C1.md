# EWO-C1

> Section: Cluster C — order summaries + tax display

**Ruling EWO-C1 — issue 2210: inclusive VAT renders as a caption after Total on every post-purchase
order summary.** `orderTaxPlacement(order)` (`packages/shared/src/order-tax-display.ts`) reads the
frozen `Order.taxIncludedInPrice` (M3-8) and returns either a summed-row amount (exclusive, the
default and every existing order) or an "Incl. VAT" caption amount (inclusive). Wired into the
storefront order detail, the admin SummaryCard, the orders-PWA SummaryCard (a fourth surface the
issue did not name) and the invoice HTML. No payload change was needed: all three order-detail
reads (`OrderService.getById`, `InvoiceService.generateInvoice`) use `include`, which already
returns every scalar column. Display only — no amount, total, charge or persisted value changes.
Tests: `tests/unit/order-tax-display-post-purchase.test.ts` + both SummaryCard render tests;
breaking the helper's inclusive branch turns 6 tests red. Cost if wrong: an inclusive order's
summary omits the tax row it previously (wrongly) summed — nothing is live today (0 active
inclusive-VAT rates, M3-9).
