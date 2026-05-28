# Lifecycle Event Coverage Audit

_Date: 2026-05-28 | Branch: feat/admin-event-lifecycle-viewers_

## Summary

Every `*_events` / `*_history` table (or JSON history column) in the schema,
its current UI coverage state, and what shipped in this PR.

---

## Tables audited

### 1. `payment_events` (PaymentEvent)

| Field              | Value                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| FK                 | `paymentId` → `payments.id`                                                       |
| Events logged      | created, status*change, webhook_received, admin_action, reconciliation, refund*\* |
| Admin UI           | PaymentEventsTimeline embedded in order detail                                    |
| Shipped in this PR | nothing new (already had UI)                                                      |

---

### 2. `affiliate_events` (AffiliateEvent)

| Field              | Value                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FK                 | `affiliateId` → `affiliates.id`                                                                                                                                                                |
| Events logged      | created, approve, reject, suspend, reactivate, commission_recorded, payout_initiated, payout_completed                                                                                         |
| Bug fixed          | Duplicate Express route `GET /:storeId/affiliates/:id/events` shadowed the `listAffiliateEvents` handler. The second handler was renamed to `/audit-trail` so both routes serve distinct data. |
| Admin UI BEFORE    | Bug: `/events` page served combined referrals+payouts instead of the actual `affiliate_events` table                                                                                           |
| Admin UI AFTER     | New `/stores/[id]/affiliates/[affiliateId]/audit-trail` page reads `affiliate_events` directly via `GET /affiliates/:id/audit-trail`                                                           |
| Shipped in this PR | New page + new API endpoint + "Audit Trail" link from existing events page                                                                                                                     |

---

### 3. `audit_logs` — order lifecycle

| Field              | Value                                           |
| ------------------ | ----------------------------------------------- |
| Scope              | `resourceType='order'`, `resourceId=orderId`    |
| Admin UI           | OrderLifecycleTimeline embedded in order detail |
| Shipped in this PR | nothing new                                     |

---

### 4. `Shipment.statusHistory` (JSON column — not a relational table)

| Field              | Value                                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| Shape              | `Json @default("[]") — array of {status, timestamp, location?, description?}` |
| Admin UI           | OrderLifecycleTimeline merges shipment.statusHistory into the order timeline  |
| Shipped in this PR | nothing new — already surfaced inline on order detail                         |

---

### 5. `audit_logs` — return lifecycle

| Field              | Value                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Scope              | `resourceType='return'`, `resourceId=returnId`                                                               |
| Actions logged     | return.created, return.approved, return.rejected, return.received, return.completed, return.tracking_updated |
| Admin UI BEFORE    | None — return state transitions were invisible                                                               |
| Admin UI AFTER     | ReturnLifecycleTimeline component embedded in ReturnDetailsDrawer (collapsible section above action buttons) |
| API endpoint       | New `GET /stores/:storeId/returns/admin/:id/timeline`                                                        |
| Shipped in this PR | New component + new API endpoint + embedded in return detail drawer                                          |

---

### 6. `inventory_history` (InventoryHistory)

| Field              | Value                                        |
| ------------------ | -------------------------------------------- |
| FK                 | `productId` → `products.id`                  |
| Admin UI           | StockMovementLog at `/stores/[id]/inventory` |
| Shipped in this PR | nothing new                                  |

---

## Coverage after this PR

| Table / Data source           | UI before                 | UI after               |
| ----------------------------- | ------------------------- | ---------------------- |
| `payment_events`              | has UI                    | has UI                 |
| `affiliate_events`            | bug (shadowed route)      | fixed + dedicated page |
| `audit_logs` (order)          | has UI                    | has UI                 |
| `Shipment.statusHistory` JSON | has UI via order timeline | has UI                 |
| `audit_logs` (return)         | missing                   | fixed                  |
| `inventory_history`           | has UI                    | has UI                 |

**All lifecycle event data now has a UI viewer.**

---

## Deferred

### Future improvements (not in scope for this PR):

1. **Return shipped transition** — `return.shipped` audit action is not being written when
   `Return.shippedAt` is set. The timeline will show no `return.shipped` entry until that
   mutation site writes the audit log.

2. **Dedicated shipment page** — if a merchant wants to view shipment history independently
   (not via order detail), a `/stores/[id]/orders/[orderId]/shipment` sub-page would be
   useful. Data is already served via `/orders/:orderId/timeline`.

3. **LoyaltyTransaction** — has a viewer at `/stores/[id]/loyalty/transactions`. Not a
   `*_events` table but serves the same auditing purpose — already covered.

---

## Files changed

### API

- `apps/api/src/routes/return.routes.ts` — added `GET /admin/:id/timeline` endpoint; added `prisma` import
- `apps/api/src/routes/affiliate.routes.ts` — renamed duplicate `/events` handler to `/audit-trail`

### Admin UI

- `apps/admin/src/components/return-timeline/ReturnLifecycleTimeline.tsx` — new collapsible timeline component
- `apps/admin/src/app/stores/[id]/returns/_components/ReturnDetailsDrawer.tsx` — embedded timeline; added `storeId` prop
- `apps/admin/src/app/stores/[id]/returns/page.tsx` — pass `storeId` to drawer
- `apps/admin/src/app/stores/[id]/affiliates/[affiliateId]/audit-trail/page.tsx` — new viewer for `affiliate_events` table
- `apps/admin/src/app/stores/[id]/affiliates/[affiliateId]/events/page.tsx` — added "Audit Trail" cross-link

### Tests

- `tests/integration/lifecycle-events.test.ts` — return timeline (auth + 404 + happy path + tenant scoping) + affiliate audit-trail (auth + empty + with events + tenant scoping)
