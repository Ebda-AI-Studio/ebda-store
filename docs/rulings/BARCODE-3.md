# BARCODE-3

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling BARCODE-3 - Ebda's own billing receipt always prints the PALM shape of `EBD-<10 hex of the charge id>` (no invoice-number sequence exists for subscription charges). The printer hardware + feed moved from the storefront into `@ebda/ui` `ReceiptPrinterShell`, shared by both. Cost if wrong: swap the constant `EBDA_BILLING_BARCODE_SHAPE`, or add a real invoice sequence and change `billingPaymentNumber`.
