# PROVIDERS-7

> Section: 2026-10-07 — Provider catalog, Batch 0 + payments Batch 1 (PROVIDERS-\*)

Ruling PROVIDERS-7 — the inherited iCarry carrier is NOT deleted in this PR. Ahmad's scope (2026-10-07) is shipping = Bosta, ShipBlu, Mylerz, Aramex (+ manual), and the instruction was to delete iCarry "if unused"; it is wired, not dead: `icarry.carrier.ts`, the `/webhooks/shipping/icarry` route, `shipping-carrier.service.ts`, the admin `ICarryCarrierCard`, COD reconciliation, i18n, 8 test files and the defence-mutation record reference it (23 code/test files). Removing it is a shipping-side feature removal that belongs in the shipping batch, where the carriers move onto this catalog (the catalog's `kind: 'shipping'` is ready for that; no carrier entry is added here so nothing half-wired ships). Cost if wrong: iCarry stays selectable in the carrier settings until the shipping batch lands.
