# EBDA-FUNNEL-15

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-15 — Amelia is a REGULAR client. Nothing assigns `founding_free` (it stays hidden and unassigned, harmless: never purchasable, only a deliberate super-admin assignment would use it). Removing the row would need a migration that touches #10's catalog for no gain. `scripts/ebda-seed-amelia.mjs` now puts her store on Growth, not `comped`. In production Ahmad records her InstaPay payment from super-admin → Billing ("Record manual payment & activate"; idempotent on the reference, audit-logged, writes a `manual_payment` ledger row). When that period ends she follows the normal path (card charge if a card is on file, else reminders → overdue → suspension). Moving her live store off `comped` is a production data action for Ahmad; it was not done here. Cost if wrong: n/a.
