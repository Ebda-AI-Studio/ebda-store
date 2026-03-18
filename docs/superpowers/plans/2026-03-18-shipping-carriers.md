# Shipping Carrier Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build full-auto shipping integration with iCarry (Kuwait) and Aramex (GCC/international) — auto-create shipments, get tracking, webhooks for delivery status, per-store credentials.

**Architecture:** Pluggable ShippingCarrierProvider interface with iCarry + Aramex implementations. ShippingService orchestrator. Shipment model tracks per-order shipments. Tracking cron polls carrier APIs. Webhooks for real-time updates. Encrypted per-store credentials.

**Tech Stack:** Prisma, Express.js, Redis (caching + cron locking), raw fetch for carrier APIs, existing encryption + feature toggle

**Spec:** `docs/superpowers/specs/2026-03-18-shipping-carriers-design.md`

---

## File Structure

**New files:**
| File | Responsibility |
|------|---------------|
| `apps/api/src/services/carriers/types.ts` | ShippingCarrierProvider interface + shared types |
| `apps/api/src/services/carriers/icarry.carrier.ts` | iCarry API implementation |
| `apps/api/src/services/carriers/aramex.carrier.ts` | Aramex API implementation |
| `apps/api/src/services/shipping.service.ts` | Orchestrator: create/cancel/track, config, cron |
| `apps/api/src/routes/shipping-carrier.routes.ts` | Admin + public endpoints |
| `apps/admin/src/app/stores/[id]/shipping-carriers/page.tsx` | Admin carrier config + shipments UI |
| `tests/unit/shipping.test.ts` | Unit tests |

**Modified files:**
| File | Change |
|------|--------|
| `packages/database/prisma/schema.prisma` | Add ShippingCarrierConfig, Shipment models |
| `apps/api/src/routes/index.ts` | Mount shipping carrier routes |
| `apps/api/src/routes/webhook.routes.ts` | Add carrier webhook endpoints |
| `apps/api/src/index.ts` | Start tracking cron |
| `apps/api/src/services/order.service.ts` | Trigger auto-ship on order confirmation |
| `apps/admin/src/app/stores/[id]/settings/page.tsx` | Add settings card |

---

## Task 1: Prisma Schema + Carrier Types

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Create: `apps/api/src/services/carriers/types.ts`

- [ ] **Step 1: Add ShippingCarrierConfig and Shipment models to schema**

Read schema. Add after recommendation models. ShippingCarrierConfig with encrypted credentials, Shipment with full tracking fields. Add relations to Store and Order.

- [ ] **Step 2: Create carrier types file**

Define `ShippingCarrierProvider` interface, `ShipmentStatus` type, `CarrierCredentials` types, `CARRIER_REGISTRY` placeholder.

- [ ] **Step 3: Run prisma generate + commit**

```bash
npm run db:generate
git commit -m "feat(database): add shipping carrier config and shipment models"
```

---

## Task 2: iCarry + Aramex Carrier Implementations

**Files:**

- Create: `apps/api/src/services/carriers/icarry.carrier.ts`
- Create: `apps/api/src/services/carriers/aramex.carrier.ts`

- [ ] **Step 1: Create iCarry carrier**

Implements ShippingCarrierProvider. Uses raw fetch to iCarry API. Methods: createShipment, trackShipment, cancelShipment, processWebhook, testConnection. Status mapping from iCarry statuses to normalized.

NOTE: iCarry's actual API may differ from spec assumptions. Implement the interface with reasonable request/response shapes. The exact API can be adjusted when real credentials are available.

- [ ] **Step 2: Create Aramex carrier**

Implements ShippingCarrierProvider. Uses raw fetch to Aramex REST API. Credentials in request body (not header). createShipment, trackShipment, cancelShipment, processWebhook, testConnection.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): add icarry and aramex carrier implementations"
```

---

## Task 3: Shipping Service (Orchestrator)

**Files:**

- Create: `apps/api/src/services/shipping.service.ts`

- [ ] **Step 1: Create the service**

Imports: prisma, redis, encryption, featureService, notificationDispatcher, logger, config.

Methods:

- `createShipmentForOrder(storeId, orderId, carrierCode?)` — main auto-ship flow
- `cancelShipment(shipmentId)` — cancel via carrier API + update DB
- `updateShipmentStatus(shipmentId)` — poll carrier for status, update DB + order
- `getCarrierConfigs(storeId)` — cached in Redis, encrypted credentials
- `upsertCarrierConfig(storeId, carrier, data)` — encrypt + upsert
- `setDefaultCarrier(storeId, carrier)` — unset other defaults
- `testConnection(storeId, carrier)` — call carrier.testConnection()
- `startTrackingCron(intervalMs=1800000)` / `stopTrackingCron()` — polls active shipments
- `listShipments(storeId, options)` — paginated query

Tracking cron: Redis lock, query non-delivered shipments, poll each, update statuses, notify on delivery.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(api): add shipping service with auto-ship and tracking cron"
```

---

## Task 4: API Routes + Webhooks

**Files:**

- Create: `apps/api/src/routes/shipping-carrier.routes.ts`
- Modify: `apps/api/src/routes/index.ts`
- Modify: `apps/api/src/routes/webhook.routes.ts`

- [ ] **Step 1: Create shipping carrier routes**

Admin routes (gated by shipping_carriers feature):

- Config CRUD, test connection, set default
- Ship order, cancel shipment
- List shipments, shipment detail, force-track

Public route: GET tracking for customer's order.

- [ ] **Step 2: Add carrier webhooks**

In webhook.routes.ts add:

- POST /webhooks/shipping/icarry
- POST /webhooks/shipping/aramex

Each: parse payload, find shipment, update status. Always 200.

- [ ] **Step 3: Mount + commit**

```bash
git commit -m "feat(api): add shipping carrier routes and webhooks"
```

---

## Task 5: Order Auto-Ship Integration + Cron Boot

**Files:**

- Modify: `apps/api/src/services/order.service.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Trigger auto-ship on order confirmation**

In order.service.ts updateStatus(), when status changes to 'confirmed':

```typescript
if (status === 'confirmed') {
  // Auto-ship if carrier configured (fire-and-forget)
  shippingService
    .createShipmentForOrder(storeId, orderId)
    .catch(err => logger.error('Auto-ship failed:', err));
}
```

- [ ] **Step 2: Start tracking cron on boot**

In index.ts after other crons:

```typescript
shippingService.startTrackingCron(1800000); // 30 min
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(order): auto-ship on confirmation and start tracking cron"
```

---

## Task 6: Admin UI + Settings Card

**Files:**

- Create: `apps/admin/src/app/stores/[id]/shipping-carriers/page.tsx`
- Modify: `apps/admin/src/app/stores/[id]/settings/page.tsx`

- [ ] **Step 1: Create shipping carriers page**

Carrier cards (iCarry + Aramex) with credentials forms, enable/disable, set default, test connection. Pickup address form. Active shipments table with status badges, carrier filter, pagination.

- [ ] **Step 2: Add settings card**

In settings page: "Shipping Carriers" card, featureKey: 'shipping_carriers'.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(admin): add shipping carrier configuration and shipments page"
```

---

## Task 7: Unit Tests + Verification

**Files:**

- Create: `tests/unit/shipping.test.ts`

- [ ] **Step 1: Write tests**

1. ShipmentStatus type has all expected values
2. Carrier registry has icarry + aramex
3. Status mapping: iCarry statuses map to normalized
4. Status mapping: Aramex statuses map to normalized
5. Config encryption round-trip
6. Auto-ship skips when no carrier configured

- [ ] **Step 2: Run tests + build**

```bash
npx vitest run tests/unit/shipping.test.ts
npm run build
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(api): add unit tests for shipping carrier integrations"
```
