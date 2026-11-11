# ORDER-NUMBER-FULL-1

> Section: Shopper QA 2026-11-11 (Amelia Aurum), branch `fix/order-copy-money-toasts`

**Ruling ORDER-NUMBER-FULL-1 - the full order number is shown everywhere a person reads it; amends IA-14.**
The orders list no longer truncates to «#…-DRHWY», and the success receipt prints `#ORD-TOBCT4-DRHWY` once (no
grouped copy plus a screen-reader copy). Evidence: the merchant matches the number the shopper quotes against the
list; the truncated and grouped forms matched neither. The IA-14 grouping helper stays exported, unused. Money on the
admin order pages now uses the shared `formatMoney` (QA-D4: `4,850 ج.م` / `EGP 4,850`); fiscal documents keep their
own fixed format. The orders list API now also returns a derived `paymentMethod` (QA-D1). Cost if wrong: a very long
custom order number wraps onto two lines in the list.
