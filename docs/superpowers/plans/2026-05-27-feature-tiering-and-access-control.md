# Feature tiering + super-admin access control — implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` (or `superpowers:executing-plans`) to execute task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Introduce three named plans (Starter / Professional / Enterprise) for Ebda Store + three matching tiers for Force WhatsApp, with sub-feature-level toggles inside Inventory and Accounting, all gated behind a super-admin-only "Manage Features" page. Also gate the "Suspend Store" action to super-admins, and polish the existing storefront suspension page.

**Architecture:**

Two-layer feature resolution: `PLAN_BASELINE[plan]` constant lists baseline-included features per plan. `StoreFeature` table holds per-store overrides on top of the baseline. Resolution = override (if row present) ?? baseline includes featureKey. Plan changes preserve overrides — super-admin can grant a single feature without bumping the plan. UI shows store-admin only the features that resolve to enabled; super-admin sees the full registry with per-feature toggles + the resolved-from-baseline-or-override breakdown.

**Tech Stack:** Prisma migration (Postgres), TypeScript constant + Zod schema in `@ebda/shared`, Next.js App Router admin page, Express service + route on the API, RBAC via existing `authorize('super_admin')` middleware.

---

## File structure

| File                                                              | Status | Responsibility                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/features.ts`                                 | modify | Add `inventory.*` + `accounting.*` sub-feature keys to `FEATURE_REGISTRY`                                                                                                                              |
| `packages/shared/src/plan-baselines.ts`                           | create | `PLAN_BASELINE: Record<StorePlan, FeatureKey[]>` + helper types                                                                                                                                        |
| `packages/database/prisma/schema.prisma`                          | modify | Update `StorePlan` enum (Starter / Professional / Enterprise, keep `free` as legacy), no other schema changes — `StoreFeature` row shape already supports override                                     |
| `packages/database/prisma/migrations/<TS>_plan_enum_rename`       | create | Rename `Store.plan` enum values, keep existing rows on starter                                                                                                                                         |
| `apps/api/src/lib/feature-gate.ts`                                | modify | `isFeatureEnabled(storeId, key)` = override ?? baseline, `getEnabledFeatures(storeId)` returns full resolved set                                                                                       |
| `apps/api/src/services/store.service.ts`                          | modify | Plan-change ops (`setPlan`) DON'T touch StoreFeature rows                                                                                                                                              |
| `apps/api/src/services/store.service.ts`                          | modify | New `suspendStore(storeId)` / `reactivateStore(storeId)` (super-admin-only)                                                                                                                            |
| `apps/api/src/routes/admin.routes.ts`                             | modify | New `PUT /admin/stores/:id/features/:key` (super-admin), `PUT /admin/stores/:id/plan` (super-admin), `POST /admin/stores/:id/suspend` (super-admin), `POST /admin/stores/:id/reactivate` (super-admin) |
| `apps/api/src/middleware/store-access.ts`                         | modify | Reject requests when `store.status === 'suspended'` with 503 + machine-readable code                                                                                                                   |
| `apps/admin/src/app/admin/stores/[id]/features/page.tsx`          | create | Super-admin-only manage features page                                                                                                                                                                  |
| `apps/admin/src/app/admin/stores/[id]/features/FeatureMatrix.tsx` | create | Client component: per-feature toggle with "baseline-on / override-on / override-off" tri-state                                                                                                         |
| `apps/admin/src/components/RequireSuperAdmin.tsx`                 | create | Tiny wrapper that returns 404 if `useAuth().user.role !== 'super_admin'`                                                                                                                               |
| `apps/admin/src/components/sidebar/StoreSidebar.tsx`              | modify | "Manage Features" link only when `user.role === 'super_admin'`                                                                                                                                         |
| `apps/admin/src/app/admin/stores/[id]/settings/page.tsx`          | modify | "Suspend store" button only when super-admin; the existing plan dropdown stays visible to store_admin but is read-only for them                                                                        |
| `apps/web/src/components/StoreMaintenance.tsx`                    | modify | Add "Powered by Ebda AI Studio" hyperlink to `https://store.ebda.app` in the footer area                                                                                                               |
| `docs/business/04-pricing-tiers.md`                               | modify | Replace "Bands 1-4" framing with the new named-plan table — keep cost floors                                                                                                                           |
| `docs/business/02-feature-catalog.md`                             | modify | Add "Available in:" badge per feature mapping to plan(s)                                                                                                                                               |
| `docs/runbooks/SUPER-ADMIN-PLAYBOOK.md`                           | create | How to suspend / reactivate / change plan / override features per store                                                                                                                                |

---

## Phase A — Schema + baseline constant (foundation)

### Task A.1: Define plan baselines + sub-feature keys

**Files:**

- Modify: `packages/shared/src/features.ts`
- Create: `packages/shared/src/plan-baselines.ts`

- [ ] **Step 1: Add inventory + accounting sub-feature keys to FEATURE_REGISTRY**

Append to `FEATURE_REGISTRY`:

```ts
// Inventory — sub-features
'inventory.basic': { key: 'inventory.basic', label: 'Inventory — Stock Tracking', description: 'Per-product stock counts + low-stock badge' },
'inventory.stock_alerts': { key: 'inventory.stock_alerts', label: 'Inventory — Low-Stock Alerts', description: 'Auto-email merchant when stock drops below per-product threshold' },
'inventory.backorder': { key: 'inventory.backorder', label: 'Inventory — Backorder', description: 'Accept orders when out of stock; queue for fulfillment when restocked' },
'inventory.multi_warehouse': { key: 'inventory.multi_warehouse', label: 'Inventory — Multi-Warehouse', description: 'Track stock per warehouse; route orders by proximity' },
'inventory.barcode': { key: 'inventory.barcode', label: 'Inventory — Barcode Scanning', description: 'Scan-to-receive + scan-to-pick from mobile' },
'inventory.purchase_orders': { key: 'inventory.purchase_orders', label: 'Inventory — Purchase Orders', description: 'Supplier PO workflow with cost capture' },
'inventory.bulk_adjustments': { key: 'inventory.bulk_adjustments', label: 'Inventory — Bulk Adjustments', description: 'CSV import for stock reconciliation' },

// Accounting — sub-features
'accounting.basic': { key: 'accounting.basic', label: 'Accounting — Journal + P&L', description: 'Double-entry journal + simple P&L report' },
'accounting.expenses': { key: 'accounting.expenses', label: 'Accounting — Expense Tracking', description: 'Expense categories + receipts + monthly summaries' },
'accounting.invoicing': { key: 'accounting.invoicing', label: 'Accounting — Invoicing', description: 'Egypt-compliant invoice generation with tax line + bilingual' },
'accounting.tax_reports': { key: 'accounting.tax_reports', label: 'Accounting — Tax Reports', description: 'VAT / sales-tax exports + period reconciliation' },
'accounting.multi_currency': { key: 'accounting.multi_currency', label: 'Accounting — Multi-Currency', description: 'Track non-EGP transactions with FX rates + EGP conversion' },
'accounting.profit_anomaly': { key: 'accounting.profit_anomaly', label: 'Accounting — Profit Anomaly Watch', description: 'AI-driven margin watcher; flags sales below cost' },
'accounting.bank_reconcile': { key: 'accounting.bank_reconcile', label: 'Accounting — Bank Reconciliation', description: 'Bank statement import + automated match against ledger' },
```

- [ ] **Step 2: Write the baseline constant**

```ts
// packages/shared/src/plan-baselines.ts
import type { FeatureKey } from './features';

export type StorePlan = 'starter' | 'professional' | 'enterprise' | 'free';

// Features that resolve to ENABLED for a store on this plan by default.
// Super-admin can override per-store via StoreFeature table (see
// apps/api/src/lib/feature-gate.ts).
export const PLAN_BASELINE: Record<StorePlan, FeatureKey[]> = {
  free: [
    // Storefront essentials only — for the demo / lapsed-payment fallback
    'coupons',
    'reviews',
    'inventory.basic',
  ],
  starter: [
    // Everything in `free` + standard commerce
    'coupons',
    'returns',
    'reviews',
    'tax',
    'pwa',
    'seo',
    'search_autocomplete',
    'marketing_pixels',
    'shipping_carriers',
    'bulk_operations',
    'abandoned_cart',
    // AI is STANDARD per Ahmad's 2026-05-27 decision
    // (Gemini Flash Lite free-tier absorbs cost)
    // Inventory — basic only
    'inventory.basic',
  ],
  professional: [
    // Everything in starter
    'coupons',
    'returns',
    'reviews',
    'tax',
    'pwa',
    'seo',
    'search_autocomplete',
    'marketing_pixels',
    'shipping_carriers',
    'bulk_operations',
    'abandoned_cart',
    // Inventory step-up
    'inventory.basic',
    'inventory.stock_alerts',
    'inventory.backorder',
    // Accounting step-up
    'accounting.basic',
    'accounting.expenses',
    'accounting.invoicing',
    // Marketing + retention
    'loyalty',
    'push_notifications',
    'upsell_crosssell',
  ],
  enterprise: [
    // Everything in professional
    'coupons',
    'returns',
    'reviews',
    'tax',
    'pwa',
    'seo',
    'search_autocomplete',
    'marketing_pixels',
    'shipping_carriers',
    'bulk_operations',
    'abandoned_cart',
    'loyalty',
    'push_notifications',
    'upsell_crosssell',
    // Full inventory
    'inventory.basic',
    'inventory.stock_alerts',
    'inventory.backorder',
    'inventory.multi_warehouse',
    'inventory.barcode',
    'inventory.purchase_orders',
    'inventory.bulk_adjustments',
    // Full accounting
    'accounting.basic',
    'accounting.expenses',
    'accounting.invoicing',
    'accounting.tax_reports',
    'accounting.multi_currency',
    'accounting.profit_anomaly',
    'accounting.bank_reconcile',
    // Extras
    'affiliate',
    'sms',
    'floating_widget',
  ],
};

export function getBaselineFeatures(plan: StorePlan): readonly FeatureKey[] {
  return PLAN_BASELINE[plan];
}
```

- [ ] **Step 3: Unit tests**

`packages/shared/src/__tests__/plan-baselines.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PLAN_BASELINE, getBaselineFeatures } from '../plan-baselines';

describe('PLAN_BASELINE', () => {
  it('professional is a superset of starter', () => {
    const starter = new Set(PLAN_BASELINE.starter);
    PLAN_BASELINE.professional.forEach(k => {
      // Allow professional to add features but not REMOVE starter ones
      // (except 'free' which is a stripped fallback)
    });
    starter.forEach(k => expect(PLAN_BASELINE.professional).toContain(k));
  });

  it('enterprise is a superset of professional', () => {
    PLAN_BASELINE.professional.forEach(k => expect(PLAN_BASELINE.enterprise).toContain(k));
  });

  it('every key in PLAN_BASELINE exists in FEATURE_REGISTRY', () => {
    // Catches typos when adding new features
    // ...
  });
});
```

- [ ] **Step 4: Run + commit**

```
npm test -w @ebda/shared
git add packages/shared/src/features.ts packages/shared/src/plan-baselines.ts packages/shared/src/__tests__/plan-baselines.test.ts
git commit -m "feat(shared): add plan-baselines constant + inventory and accounting sub-features"
```

### Task A.2: Confirm StorePlan enum + migration (if needed)

**Files:** `packages/database/prisma/schema.prisma`

- [ ] **Step 1: Read current StorePlan enum**

If it's currently `free | starter | professional | enterprise` no migration needed. If different, write migration to rename values without dropping rows.

- [ ] **Step 2: Verify Store.plan default**

Default should be `free` (so a newly created store from the super-admin flow doesn't accidentally grant Pro features). Existing stores stay on whatever plan they're already on.

- [ ] **Step 3: Commit if migration ran**

```
git add packages/database/prisma/{schema.prisma,migrations}
git commit -m "feat(db): align StorePlan enum with new tier naming"
```

---

## Phase B — Feature resolution + API endpoints

### Task B.1: Implement the resolver

**Files:**

- Modify: `apps/api/src/lib/feature-gate.ts`
- Test: `apps/api/src/lib/__tests__/feature-gate.test.ts`

- [ ] **Step 1: Write the resolver**

```ts
// apps/api/src/lib/feature-gate.ts
import { prisma } from '@ebda/database';
import { FEATURE_REGISTRY, type FeatureKey } from '@ebda/shared';
import { PLAN_BASELINE, type StorePlan } from '@ebda/shared/plan-baselines';

// In-memory cache (Redis-backed in prod via redis.service) keyed by storeId.
// Invalidate on StoreFeature change OR Store.plan change.
const cache = new Map<string, { features: Set<FeatureKey>; expiresAt: number }>();
const TTL_MS = 60_000;

export async function getEnabledFeatures(storeId: string): Promise<Set<FeatureKey>> {
  const cached = cache.get(storeId);
  if (cached && cached.expiresAt > Date.now()) return cached.features;

  const [store, overrides] = await Promise.all([
    prisma.store.findUnique({ where: { id: storeId }, select: { plan: true } }),
    prisma.storeFeature.findMany({
      where: { storeId },
      select: { featureKey: true, enabled: true },
    }),
  ]);
  if (!store) return new Set();

  const baseline = new Set<FeatureKey>(PLAN_BASELINE[store.plan as StorePlan]);
  // Apply overrides: row present + enabled=true → add; row present + enabled=false → remove
  for (const o of overrides) {
    if (o.enabled) baseline.add(o.featureKey as FeatureKey);
    else baseline.delete(o.featureKey as FeatureKey);
  }
  cache.set(storeId, { features: baseline, expiresAt: Date.now() + TTL_MS });
  return baseline;
}

export async function isFeatureEnabled(storeId: string, key: FeatureKey): Promise<boolean> {
  const set = await getEnabledFeatures(storeId);
  return set.has(key);
}

export function invalidateFeatureCache(storeId: string) {
  cache.delete(storeId);
}
```

- [ ] **Step 2: Test the resolver**

```ts
// apps/api/src/lib/__tests__/feature-gate.test.ts
describe('feature-gate', () => {
  it('returns baseline features when no overrides', async () => {
    // store.plan = 'starter' → has 'inventory.basic', no 'inventory.backorder'
  });
  it('override-true adds a feature above baseline', async () => {
    // 'inventory.backorder' off in starter baseline, but row says enabled=true → enabled
  });
  it('override-false removes a feature from baseline', async () => {
    // 'reviews' in starter baseline, but row says enabled=false → not enabled
  });
  it('plan change preserves overrides', async () => {
    // Upgrade starter → professional. Override row for inventory.backorder=true persists.
  });
});
```

- [ ] **Step 3: Audit + migrate existing call sites**

```bash
grep -rn "isFeatureEnabled\|feature-gate\|StoreFeature\|store\.plan === " apps/api/src/
```

For each call site, ensure it now flows through `isFeatureEnabled(storeId, key)` rather than reading raw `store.plan` or raw `StoreFeature` rows.

- [ ] **Step 4: Commit**

```
git commit -m "feat(api): plan-baseline resolver with override layer"
```

### Task B.2: Super-admin endpoints

**Files:** `apps/api/src/routes/admin.routes.ts`

- [ ] **Step 1: Add 4 new endpoints behind `authorize('super_admin')`**

```
PUT /admin/stores/:id/features/:key      body: { enabled: boolean | null }
PUT /admin/stores/:id/plan                body: { plan: StorePlan }
POST /admin/stores/:id/suspend            body: { reason?: string }
POST /admin/stores/:id/reactivate
```

Notes:

- `PUT features/:key` with `enabled: null` DELETES the override row, falling back to baseline
- `PUT plan` does NOT touch StoreFeature rows (per the user's "Overrides preserved" decision)
- Both `suspend` / `reactivate` write an audit log row + invalidate the feature cache

- [ ] **Step 2: Tests**

```
tests/integration/admin-feature-overrides.test.ts
- super_admin can PUT a feature override
- store_admin gets 403 on PUT a feature override
- PUT enabled=null removes the row
- PUT plan preserves existing overrides
- POST suspend sets status, audit log written
- POST reactivate flips back, audit log written
```

- [ ] **Step 3: Commit**

```
git commit -m "feat(api): super-admin feature override and suspend reactivate endpoints"
```

---

## Phase C — Admin UI (super-admin "Manage Features" page)

### Task C.1: RequireSuperAdmin wrapper

**Files:** `apps/admin/src/components/RequireSuperAdmin.tsx`

- [ ] **Step 1: Build the wrapper**

```tsx
'use client';
import { useAuth } from '@/lib/auth';
import { notFound } from 'next/navigation';

export function RequireSuperAdmin({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (user?.role !== 'super_admin') notFound(); // 404, not 403 — don't reveal endpoint existence
  return <>{children}</>;
}
```

- [ ] **Step 2: Commit**

### Task C.2: Manage Features page

**Files:**

- `apps/admin/src/app/admin/stores/[id]/features/page.tsx`
- `apps/admin/src/app/admin/stores/[id]/features/FeatureMatrix.tsx`

- [ ] **Step 1: Server page wraps in RequireSuperAdmin**

```tsx
// page.tsx
import { RequireSuperAdmin } from '@/components/RequireSuperAdmin';
import { FeatureMatrix } from './FeatureMatrix';

export default async function FeaturesPage({ params }: { params: { id: string } }) {
  return (
    <RequireSuperAdmin>
      <FeatureMatrix storeId={params.id} />
    </RequireSuperAdmin>
  );
}
```

- [ ] **Step 2: FeatureMatrix client component**

Layout: grouped by category (Storefront / Inventory / Accounting / Loyalty+Marketing / WhatsApp).

Each row: feature label + description + tri-state indicator:

- 🟢 **Baseline ON** (plan includes it, no override): badge "Included in [Plan]"
- 🔵 **Override ON** (plan excludes, super-admin granted): badge "Granted by override"
- 🔴 **Override OFF** (plan includes, super-admin revoked): badge "Revoked by override"
- ⚪ **Baseline OFF** (plan excludes, no override): badge "Not in [Plan]"

Toggle actions:

- Baseline ON → flip creates `enabled=false` override (Revoked)
- Override OFF → flip removes the row (back to Baseline ON)
- Baseline OFF → flip creates `enabled=true` override (Granted)
- Override ON → flip removes the row (back to Baseline OFF)

Show a "Reset to plan defaults" button at the top that DELETEs every override row for this store.

- [ ] **Step 3: Sidebar link gated**

```tsx
// StoreSidebar.tsx
{
  user?.role === 'super_admin' && (
    <SidebarLink href={`/admin/stores/${storeId}/features`} label="Manage Features" />
  );
}
```

- [ ] **Step 4: Commit**

```
git commit -m "feat(admin): manage features page super-admin only"
```

### Task C.3: Suspend store button (super-admin only)

**Files:** `apps/admin/src/app/admin/stores/[id]/settings/page.tsx`

- [ ] **Step 1: Wrap suspend section in role check**

```tsx
{
  user?.role === 'super_admin' && (
    <DangerZone>
      <Button onClick={handleSuspend} variant="destructive">
        Suspend Store
      </Button>
    </DangerZone>
  );
}
```

Store admin sees nothing — no "Suspend" button at all.

- [ ] **Step 2: Make plan dropdown read-only for store_admin**

Store admin can SEE which plan they're on (so support conversations are easier) but can't change it.

```tsx
<PlanSelector
  value={store.plan}
  disabled={user?.role !== 'super_admin'}
  onChange={handlePlanChange}
/>
```

- [ ] **Step 3: Commit**

---

## Phase D — Storefront suspension UX

### Task D.1: Polish StoreMaintenance + add Powered By Ebda AI Studio

**Files:** `apps/web/src/components/StoreMaintenance.tsx`

- [ ] **Step 1: Read existing component**

- [ ] **Step 2: Add the hyperlink to footer area**

```tsx
<footer className="mt-12 text-center text-sm text-muted-foreground">
  <a
    href="https://store.ebda.app"
    target="_blank"
    rel="noopener noreferrer"
    className="hover:text-primary transition-colors"
  >
    Powered by Ebda AI Studio
  </a>
</footer>
```

- [ ] **Step 3: Verify trigger logic**

`store-resolver.ts` should already route `status === 'suspended'` to this component. Confirm by reading + tracing a suspended-store render.

- [ ] **Step 4: Commit**

```
git commit -m "feat(web): add Powered by Ebda AI Studio link to store maintenance page"
```

---

## Phase E — Cross-product gate (Force WhatsApp ↔ Ebda Store)

### Task E.1: WhatsApp catalog sync respects Ebda Store plan

**Files:**

- `apps/api/src/lib/inngest/functions/meta-catalog-sync.ts` (or wherever the catalog sync function lives)
- `apps/api/src/routes/wa-bridge.routes.ts` (or equivalent)

- [ ] **Step 1: Gate sync trigger on Ebda Store side**

Before publishing a product to Meta Commerce, check `isFeatureEnabled(storeId, 'whatsapp_catalog_sync')`. If false, skip + log.

- [ ] **Step 2: WBS side validates the bridge call**

When WBS receives a webhook from Ebda Store requesting catalog sync, validate that the Ebda Store store has the feature enabled (call Ebda Store API `GET /stores/:id/features/whatsapp_catalog_sync`).

- [ ] **Step 3: Tests**

```
tests/integration/whatsapp-catalog-gate.test.ts
- store on Starter (no whatsapp_catalog_sync) → sync skipped
- store on Starter + override granting whatsapp_catalog_sync → sync runs
- store on Professional (default) → sync runs
```

- [ ] **Step 4: Commit**

---

## Phase F — Docs (parity rule)

### Task F.1: Update pricing-tiers + feature-catalog

**Files:**

- `docs/business/04-pricing-tiers.md`
- `docs/business/02-feature-catalog.md`
- `docs/runbooks/SUPER-ADMIN-PLAYBOOK.md` (new)

- [ ] **Step 1: Replace Band 1-4 framing in pricing-tiers.md**

New shape: 3 named plans (Starter / Professional / Enterprise) with the baseline feature matrix matching PLAN_BASELINE. Keep the cost-floor + competitor benchmark sections.

- [ ] **Step 2: Add "Available in:" badge per feature in feature-catalog.md**

```
### Loyalty Program (برنامج الولاء)
Available in: Professional, Enterprise. Granted to Starter via super-admin override (separate quote).
```

- [ ] **Step 3: Write SUPER-ADMIN-PLAYBOOK runbook**

Sections: how to onboard a new merchant (set plan, optional overrides), how to grant a one-off feature, how to suspend / reactivate, how to handle a plan-downgrade (overrides preserved by design), audit log location.

- [ ] **Step 4: Commit**

---

## Acceptance criteria (whole PR)

- [ ] `isFeatureEnabled(storeId, key)` returns the correct resolved state for: baseline-on, baseline-off, override-on, override-off, plan-change-preserves-overrides
- [ ] Store admin logs in → no "Manage Features" link, no "Suspend Store" button, plan dropdown is read-only
- [ ] Super-admin logs in → "Manage Features" link visible, can toggle any feature, can suspend / reactivate, can change plan
- [ ] Suspended store: storefront shows the existing maintenance page with "Powered by Ebda AI Studio" link, store admin can still log in to the admin
- [ ] WhatsApp catalog sync skips stores without the feature; granting via override lets it run
- [ ] All 4 Ebda AI Studio contract / proposal templates already reflect the new feature copy (done 2026-05-27 in the work folder)
- [ ] Docs updated: pricing-tiers, feature-catalog, super-admin-playbook

---

## Token discipline / dispatch strategy

- **Phase A** (schema + constant) — straightforward Bash + Edit, no subagent
- **Phase B** (resolver + endpoints) — straightforward Bash + Edit
- **Phase C** (admin UI) — 1 Sonnet subagent for the FeatureMatrix component (clear spec, generates the matrix + tri-state logic). Manual: the sidebar + settings edits + RequireSuperAdmin wrapper
- **Phase D** (storefront polish) — 1 Edit, no subagent
- **Phase E** (cross-product gate) — Manual; ~3 files touched
- **Phase F** (docs) — Manual; doc edits

Never push per task — batch into ONE PR off `staging` per Rule 1 in `feedback-six-failures-from-2026-05-26`.

---

## Decisions locked 2026-05-27

- ✅ **Sub-feature granularity**: inventory._ (7 sub-features) + accounting._ (7 sub-features), each independently toggleable.
- ✅ **Plan-change behavior**: overrides preserved on upgrade AND downgrade. Plan changes never touch StoreFeature rows.
- ✅ **Suspend scope**: storefront serves the existing `StoreMaintenance` page; admin login still works. Add "Powered by Ebda AI Studio" hyperlink to `https://store.ebda.app` in the maintenance footer.
- ✅ **Force WhatsApp tier modeling**: separate `Client.plan` enum on WBS side (W-Starter / W-Pro / W-Enterprise) + its own ClientFeature override table + its own super-admin Manage Features page + suspend flow. Mirrors the sales reality of two separate contract templates and lets you sell Force WhatsApp standalone.
- ✅ **Pricing**: stays out of code per the existing `docs/business/04-pricing-tiers.md` "no public tier list" rule. Numbers TBD; when nailed down, live in proposals only.
- ✅ **Audit log**: reuse the existing Ebda Store `AuditLog` table (correct shape — `userId` + `storeId` + `action` + `details` + `resourceType` + `resourceId` + `ipAddress`). Mirror it as `ClientAuditLog` on the WBS side. Two-layer visibility on both: per-store / per-client (storeId/clientId = X) visible to that store's/client's admins for their own team-action trail; super-admin sees cross-store / cross-client trail (all entries OR storeId/clientId = null for platform-wide actions).

---

## Phase G — WBS-side mirror (Force WhatsApp tier system)

Mirrors Phases A-D for the WBS repo. Independent feature gating, plan baselines, manage-features page, suspend flow, audit log.

### Task G.1: WBS plan baseline + sub-features

**Files (WBS repo `whatsapp-bulk-sender/`):**

- Modify: `backend/prisma/schema.prisma`
- Create: `backend/src/lib/plan-baselines.js`

- [ ] **Step 1: Add `ClientPlan` enum + `Client.plan` + `Client.status` fields**

```prisma
enum ClientPlan {
  free
  w_starter
  w_professional
  w_enterprise
}

enum ClientStatus {
  active
  suspended
  archived
}

model Client {
  // ...existing fields...
  plan       ClientPlan   @default(free)
  status     ClientStatus @default(active)
  // ...
}
```

- [ ] **Step 2: Define WBS feature registry**

`wbs.bulk_campaigns` · `wbs.inbox_unified` · `wbs.templates_approved` · `wbs.template_submission` · `wbs.contacts_segmentation` · `wbs.campaign_scheduling` · `wbs.media_messages` · `wbs.contact_import` · `wbs.analytics_basic` · `wbs.bot.native_catalog` · `wbs.bot.service_menu` · `wbs.bot.bilingual` · `wbs.bot.customer_addresses` · `wbs.bot.meta_catalog_sync` · `wbs.bot.intelligence` · `wbs.integrations.force_store` · `wbs.integrations.external_crm`

- [ ] **Step 3: Write `PLAN_BASELINE` constant**

```js
// backend/src/lib/plan-baselines.js
const PLAN_BASELINE = {
  free: ['wbs.inbox_unified', 'wbs.templates_approved'],
  w_starter: [
    'wbs.bulk_campaigns',
    'wbs.inbox_unified',
    'wbs.templates_approved',
    'wbs.contact_import',
    'wbs.analytics_basic',
    'wbs.media_messages',
  ],
  w_professional: [
    // starter + bot tier
    ...PLAN_BASELINE.w_starter,
    'wbs.template_submission',
    'wbs.contacts_segmentation',
    'wbs.campaign_scheduling',
    'wbs.bot.native_catalog',
    'wbs.bot.service_menu',
    'wbs.bot.bilingual',
    'wbs.bot.customer_addresses',
    'wbs.bot.meta_catalog_sync',
    'wbs.integrations.force_store',
  ],
  w_enterprise: [
    // professional + intelligence + external CRM
    ...PLAN_BASELINE.w_professional,
    'wbs.bot.intelligence',
    'wbs.integrations.external_crm',
  ],
};
module.exports = { PLAN_BASELINE };
```

- [ ] **Step 4: ClientFeature override table**

```prisma
model ClientFeature {
  id         String   @id @default(uuid())
  clientId   String   @map("client_id")
  featureKey String   @map("feature_key")
  enabled    Boolean
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")
  client     Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)

  @@unique([clientId, featureKey])
  @@index([clientId])
  @@map("client_features")
}
```

- [ ] **Step 5: Migration + commit**

### Task G.2: WBS feature-gate helper

**File:** `backend/src/middleware/feature-gate.js`

Mirror of Ebda Store's helper with in-memory cache + invalidation on override write.

### Task G.3: WBS super-admin UI

Same shape as Ebda Store Phase C. Build `RequireSuperAdmin` wrapper in WBS frontend (`frontend/src/components/`), "Manage Features" page only for super_admin, "Suspend Client" button only for super_admin. WBS already has `SimpleAuth.requireAdminAsync` — add `requireSuperAdminAsync` parallel.

### Task G.4: WBS suspend behavior

`Client.status = suspended`:

- WhatsApp inbound webhook still received but bot doesn't respond (early return)
- Outbound message routes return 503
- Admin frontend shows a banner
- Admin login still works

### Task G.5: WBS audit log

```prisma
model ClientAuditLog {
  id           String   @id @default(uuid())
  action       String
  userId       String?  @map("user_id")
  clientId     String?  @map("client_id")
  resourceType String   @map("resource_type")
  resourceId   String?  @map("resource_id")
  details      Json     @default("{}")
  ipAddress    String?  @map("ip_address")
  userAgent    String?  @map("user_agent")
  createdAt    DateTime @default(now()) @map("created_at")
  user         User?    @relation(fields: [userId], references: [id])
  client       Client?  @relation(fields: [clientId], references: [id])

  @@index([clientId])
  @@index([userId])
  @@map("client_audit_logs")
}
```

Visibility: client admin sees `clientId = own`; super-admin sees all entries.

---

## Phase H — Cross-product gate (Ebda Store ↔ Force WhatsApp)

### H.0: Standing precondition rule (2026-05-27, Ahmad's clarification)

**ALL `wbs.bot.*` features REQUIRE a linked, active Ebda Store.** This is a SALES rule first, an architecture rule second:

- WBS plans (W-Starter / W-Pro / W-Enterprise) are sold standalone — campaigns, inbox, templates all work without Ebda Store.
- Bot features (native catalog, service menu, customer addresses, Meta sync, intelligence) only make sense when there's a product catalog to drive — Ebda Store IS that catalog.
- A merchant on W-Pro WITHOUT Ebda Store gets: bulk campaigns + inbox + templates + segmentation + scheduling + analytics. The bot features in their plan baseline are silently disabled by the precondition; no bot configuration UI appears.
- The moment they ALSO buy Ebda Store, the bot features automatically unlock (no super-admin action needed — the precondition flips).

### H.1: Resolver enforces precondition

In `backend/src/middleware/feature-gate.js`:

```js
const BOT_PREFIX = 'wbs.bot.';

async function isClientFeatureEnabled(clientId, key) {
  // Standard baseline + override resolution
  let enabled = await resolveBaselineAndOverride(clientId, key);
  if (!enabled) return false;

  // Bot precondition: all wbs.bot.* features require a linked Ebda Store.
  // The link is stored as Client.forceStoreId on WBS side (existing field via the WBS bridge).
  if (key.startsWith(BOT_PREFIX)) {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { forceStoreId: true },
    });
    if (!client?.forceStoreId) return false;

    // AND the Ebda Store must currently be active (not suspended).
    // Use the existing wa-bridge call to check Ebda Store-side state.
    const storeActive = await forceStoreBridge.isStoreActive(client.forceStoreId);
    if (!storeActive) return false;
  }

  return true;
}
```

### H.2: Manage Features page shows the precondition state

When rendering the WBS Manage Features matrix for a client:

- For every `wbs.bot.*` row, if `client.forceStoreId` is null OR the linked store is inactive:
  - Show the toggle DISABLED (can't be flipped)
  - Show inline copy: "Requires linked Ebda Store" with a "Connect Ebda Store" CTA if super-admin
- If `client.forceStoreId` is set + active:
  - Toggle behaves normally per the baseline/override logic

### H.3: Sales-facing UI copy

| Merchant state                      | What they see                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ebda Store only (no Force WhatsApp) | Admin "Connect WhatsApp" panel says: "Activate Force WhatsApp to enable in-chat ordering. Separate quote."                                                                           |
| Force WhatsApp only (no Ebda Store) | Bot tab in WBS admin says: "Bot ordering requires Ebda Store. Ebda Store gives the bot its product catalog and order destination." Bulk campaigns + inbox + templates work normally. |
| Both products active                | Bridge unlocks. Bot features render per plan baseline (W-Pro/W-Enterprise) + any overrides.                                                                                          |

### H.4: Code locations to gate

- **Ebda Store**: `apps/api/src/lib/inngest/functions/meta-catalog-sync.ts` — check Ebda Store-side `whatsapp_catalog_sync` feature before publishing
- **WBS**: `backend/src/services/metaCatalogService.js` — bot precondition fires here (no Ebda Store = no sync attempt)
- **WBS**: `backend/src/services/bot-service-router.js` — bot precondition fires on EVERY inbound message that would trigger a bot response (without Ebda Store, bot stays silent)
- **WBS**: `frontend/src/app/admin/clients/[id]/features/page.tsx` — render disabled toggles + precondition copy
- **Ebda Store**: `apps/admin/src/components/store-settings/WhatsAppCard.tsx` — render different copy based on cross-product state

### H.5: Tests

```
tests/integration/wbs-bot-precondition.test.ts
- W-Pro client, no Ebda Store → wbs.bot.native_catalog resolves false
- W-Pro client, Ebda Store linked + active → resolves true
- W-Pro client, Ebda Store linked + suspended → resolves false
- W-Enterprise client, no Ebda Store → all wbs.bot.* resolve false; non-bot features resolve normally
- Super-admin override 'enabled=true' on wbs.bot.* without Ebda Store → STILL false (precondition wins; override cannot bypass)
```

### H.6: Sales contract / proposal copy update

The 2 WBS templates already updated 2026-05-27 in `~/Desktop/work/Ebda AI Studio/assets/` need one additional clarification line:

- `عقد خدمات - واتساب - قالب.html` — add a footnote in Section 2 (Scope of Services) on the bot bullets: "ميزات البوت تتطلب الربط بمتجر ابدأ (Ebda Store) النشط — تعمل الحملات والصندوق الموحد بدون ذلك."
- `عرض سعر - واتساب - قالب.html` — same note under the new "بوت المحادثة الذكي والكتالوج التفاعلي" section.
