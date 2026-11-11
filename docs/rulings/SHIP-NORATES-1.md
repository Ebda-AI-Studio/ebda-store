# SHIP-NORATES-1

> Section: Shopper QA 2026-11-11 (Amelia Aurum), branch `fix/checkout-shipping-ux`

**Ruling SHIP-NORATES-1 - a store with no delivery rates never shows "free" delivery.**
`POST /stores/public/:id/shipping/calculate` now returns `noRatesConfigured` (no active zone AND no active
per-area rate). The checkout then shows «التوصيل بيتحدد مع المتجر» in the delivery panel and «بيتحدد مع المتجر»
in the summary; "free" appears only when a zone/rate resolves to 0 (merchant-set free or a met threshold).
Checkout is NOT blocked: the order is still placed with shipping 0 (the order service uses the same
`calculateShipping`, so the quote total and the stored order total agree) and the merchant sets the fee with the
shopper. The admin dashboard shows a persistent, non-dismissable Egyptian-Arabic warning with a link to the
delivery page until a rate exists, and the setup-guide `shipping` step now counts per-area rates (it counted zones
only). Evidence: `calculateShipping` returned `matched:false, shippingCost:0` and the client rendered "Free" when
`storeHasAreaRates` was false. Blocking checkout was rejected: it would turn every new store's first test order
into an error. Residual: no publish-time warning in this PR (the dashboard warning is the surface). Cost if wrong:
a merchant who ignores the warning still takes orders without a delivery fee, now visibly labelled "set by the store".
