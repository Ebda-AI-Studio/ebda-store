# Agent-Readable Product JSON-LD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit `brand`, `shippingDetails` and `hasMerchantReturnPolicy` on the storefront's Product JSON-LD so AI shopping agents can filter FWB products on delivery cost, delivery time and return window — the criteria they filter on before anything else.

**Architecture:** Three additive, independently-shippable layers. `brand` is a pure derivation of data already passed to `productJsonLd`. `shippingDetails` is derived from `ShippingZone` rows fetched via the **existing** public endpoint `GET /public/:storeId/shipping` — no new API. `hasMerchantReturnPolicy` needs merchant input that does not exist yet, so it adds two nullable `Store` columns plus the admin UI to set them; when unset the field is omitted entirely rather than guessed.

**Tech Stack:** Next.js 16 App Router (`apps/web`), Express + Prisma (`apps/api`), Postgres/Neon, Vitest, schema.org Product/Offer vocabulary.

## Global Constraints

- **Never invent a policy claim.** Every field is emitted only when real merchant data backs it. A wrong `returnWindow` or `shippingRate` is a false claim about the merchant's business to Google and to buying agents — omission is always the correct fallback.
- **Platform-level only** (CLAUDE.md): no `store.slug` branching, no tenant-scoped code. Per-store _config_ is data and fine.
- **Every data has a UI** (CLAUDE.md): the new `Store` columns in Task 4 ship with their admin control in the same task, not "later".
- **New features default OFF**: both new columns are nullable with no default; JSON-LD omits the block until a merchant opts in.
- **Prices are in fils** (1 KWD = 1000 fils) throughout the DB. schema.org wants major units — divide by 1000 and `.toFixed(3)`, matching the existing `offers.price` line.
- **commitlint: all-lowercase subjects**; blank line before `Co-Authored-By`.
- Worktree: `~/.claude/scripts/new-task-worktree.sh force-website-builder feat/agent-readable-jsonld`. Never work in the root checkout. Worktrees have **no `node_modules`** — `ln -sfn ~/Desktop/projects/force-website-builder/node_modules node_modules`, and `rm -f node_modules` before any `git add`.
- Run tests with `./node_modules/.bin/vitest run <path>`; `npx vitest` resolves the wrong vite.

## File Structure

| File                                                                                | Responsibility                                                                                                                           |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/structured-data.ts` (modify)                                      | All JSON-LD shape decisions. Gains `brandJsonLd`, `shippingDetailsJsonLd`, `merchantReturnPolicyJsonLd` + wiring into `productJsonLd`.   |
| `apps/web/src/lib/shipping-public.ts` (create)                                      | Fetches `GET /public/:storeId/shipping` and normalizes zones. Isolated so `structured-data.ts` stays pure/synchronous and unit-testable. |
| `apps/web/src/app/products/[slug]/ProductDetailBody.tsx` (modify)                   | Fetches zones alongside the product and threads them into `productJsonLd`.                                                               |
| `apps/web/src/lib/store-resolver.ts` (modify)                                       | Adds the two return-policy fields to `ResolvedStore`.                                                                                    |
| `apps/api/src/routes/public.routes.ts` (modify)                                     | Adds the two return-policy fields to the store-resolve `select`.                                                                         |
| `packages/database/prisma/schema.prisma` (modify)                                   | Two nullable `Store` columns.                                                                                                            |
| `apps/admin/src/app/stores/[id]/shipping/_components/ReturnPolicyCard.tsx` (create) | Merchant UI for the return window.                                                                                                       |
| `apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts` (create)          | Unit tests for all three emitters.                                                                                                       |

---

### Task 1: `brand` on the Product node

**Files:**

- Modify: `apps/web/src/lib/structured-data.ts`
- Test: `apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts` (create)

**Interfaces:**

- Consumes: existing `ProductForJsonLd` and `ResolvedStore` (already parameters of `productJsonLd`).
- Produces: `brandJsonLd(store: Pick<ResolvedStore,'name'>): { '@type': 'Brand'; name: string }`, used by Tasks 2–4's tests as a stable neighbour.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { productJsonLd } from '../structured-data';

const store = {
  id: 's1',
  name: 'Pecannbee',
  slug: 'pecannbee',
  currency: 'KWD',
  status: 'active',
  timezone: 'Asia/Kuwait',
  template: 'modern',
  theme: {},
  socialLinks: {},
} as never;

const product = { name: 'Pecan Mix', slug: 'pecan-mix', price: 5000, inventory: 10 } as never;

describe('productJsonLd — agent-readable fields', () => {
  it('emits brand from the store name', () => {
    const ld = productJsonLd(product, store) as Record<string, unknown>;
    expect(ld.brand).toEqual({ '@type': 'Brand', name: 'Pecannbee' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts`
Expected: FAIL — `expected undefined to equal { '@type': 'Brand', ... }`

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/lib/structured-data.ts`, above `productJsonLd`:

```ts
/**
 * schema.org Brand. Agents use this to group and compare products across
 * sellers. FWB stores are single-brand, so the store name IS the brand —
 * there is no per-product brand field in the schema to prefer over it.
 */
export function brandJsonLd(store: Pick<ResolvedStore, 'name'>) {
  return { '@type': 'Brand', name: store.name };
}
```

Then inside `productJsonLd`'s returned object, immediately after the `category` spread:

```ts
    brand: brandJsonLd(store),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/structured-data.ts apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts
git commit -m "feat(seo): emit schema.org brand on product json-ld"
```

---

### Task 2: `shippingDetails` emitter (pure function)

**Files:**

- Modify: `apps/web/src/lib/structured-data.ts`
- Test: `apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts:end`

**Interfaces:**

- Consumes: `brandJsonLd` from Task 1 (same file).
- Produces: `PublicShippingZone` type and `shippingDetailsJsonLd(zones, opts)` — Task 3 fetches the zones, Task 3 passes them to `productJsonLd` as `opts.shippingZones`.

```ts
export interface PublicShippingZone {
  name: string;
  deliveryFee: number; // fils
  freeShippingThreshold: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  estimatedDays: number | null;
}
```

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import { shippingDetailsJsonLd } from '../structured-data';

describe('shippingDetailsJsonLd', () => {
  const zone = {
    name: 'Kuwait City',
    deliveryFee: 1500,
    freeShippingThreshold: 20000,
    estimatedDaysMin: 1,
    estimatedDaysMax: 3,
    estimatedDays: null,
  };

  it('uses the CHEAPEST zone rate and converts fils to KWD', () => {
    const dear = { ...zone, name: 'Far', deliveryFee: 4000 };
    const out = shippingDetailsJsonLd([dear, zone], { currency: 'KWD' })!;
    expect(out.shippingRate).toMatchObject({ value: '1.500', currency: 'KWD' });
  });

  it('emits a delivery time window from min/max days', () => {
    const out = shippingDetailsJsonLd([zone], { currency: 'KWD' })!;
    expect(out.deliveryTime.transitTime).toMatchObject({ minValue: 1, maxValue: 3 });
  });

  it('falls back to estimatedDays when min/max are absent', () => {
    const flat = { ...zone, estimatedDaysMin: null, estimatedDaysMax: null, estimatedDays: 2 };
    const out = shippingDetailsJsonLd([flat], { currency: 'KWD' })!;
    expect(out.deliveryTime.transitTime).toMatchObject({ minValue: 2, maxValue: 2 });
  });

  it('omits deliveryTime entirely when the merchant set no estimate', () => {
    const noEta = { ...zone, estimatedDaysMin: null, estimatedDaysMax: null, estimatedDays: null };
    expect(shippingDetailsJsonLd([noEta], { currency: 'KWD' })).not.toHaveProperty('deliveryTime');
  });

  it('returns null for no zones rather than claiming free shipping', () => {
    expect(shippingDetailsJsonLd([], { currency: 'KWD' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts`
Expected: FAIL — `shippingDetailsJsonLd is not a function`

- [ ] **Step 3: Write minimal implementation**

In `structured-data.ts`:

```ts
export interface PublicShippingZone {
  name: string;
  deliveryFee: number;
  freeShippingThreshold: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  estimatedDays: number | null;
}

/**
 * schema.org OfferShippingDetails.
 *
 * Agents comparing two products filter on delivery cost and delivery time
 * before almost anything else, so this is the highest-value structured field
 * FWB was missing.
 *
 * We advertise the CHEAPEST active zone. A product page has no address yet, so
 * any single number is a "from" price; quoting the cheapest is the honest
 * reading of "shipping starts at X" and matches how the storefront presents it.
 * Returns null when the merchant has configured no zones — omitting the block
 * is correct, because emitting a 0 rate would claim free shipping we cannot
 * honour at checkout.
 */
export function shippingDetailsJsonLd(zones: PublicShippingZone[], opts: { currency: string }) {
  if (!zones.length) return null;
  const cheapest = zones.reduce((a, z) => (z.deliveryFee < a.deliveryFee ? z : a));

  const min = cheapest.estimatedDaysMin ?? cheapest.estimatedDays;
  const max = cheapest.estimatedDaysMax ?? cheapest.estimatedDays;

  return {
    '@type': 'OfferShippingDetails',
    shippingRate: {
      '@type': 'MonetaryAmount',
      value: (cheapest.deliveryFee / 1000).toFixed(3),
      currency: opts.currency || 'KWD',
    },
    ...(min !== null && max !== null
      ? {
          deliveryTime: {
            '@type': 'ShippingDeliveryTime',
            transitTime: {
              '@type': 'QuantitativeValue',
              minValue: min,
              maxValue: max,
              unitCode: 'DAY',
            },
          },
        }
      : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts`
Expected: PASS (6 tests total with Task 1's)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/structured-data.ts apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts
git commit -m "feat(seo): add shipping details json-ld emitter"
```

---

### Task 3: Fetch zones and wire `shippingDetails` into the PDP

**Files:**

- Create: `apps/web/src/lib/shipping-public.ts`
- Modify: `apps/web/src/lib/structured-data.ts` (add the optional `opts` parameter to `productJsonLd`)
- Modify: `apps/web/src/app/products/[slug]/ProductDetailBody.tsx:154-157, 216-236`

**Interfaces:**

- Consumes: `shippingDetailsJsonLd`, `PublicShippingZone` (Task 2).
- Produces: `fetchPublicShippingZones(storeId: string): Promise<PublicShippingZone[]>`; `productJsonLd(product, store, opts?: { shippingZones?: PublicShippingZone[] })`.

- [ ] **Step 1: Write the fetcher**

Create `apps/web/src/lib/shipping-public.ts`:

```ts
import { API_URL } from './api';
import type { PublicShippingZone } from './structured-data';

/**
 * Zones for the storefront's JSON-LD shipping block, from the EXISTING public
 * endpoint (`GET /public/:storeId/shipping`) — no new API surface.
 *
 * Never throws: shipping detail is an SEO enhancement, and a transient failure
 * here must not 500 a product page. On failure we return [] and
 * `shippingDetailsJsonLd` omits the block.
 */
export async function fetchPublicShippingZones(storeId: string): Promise<PublicShippingZone[]> {
  if (!storeId || storeId === 'demo') return [];
  try {
    const res = await fetch(`${API_URL}/public/${encodeURIComponent(storeId)}/shipping`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const zones = json?.data?.zones;
    if (!Array.isArray(zones)) return [];
    return zones.map((z: Record<string, unknown>) => ({
      name: String(z.name ?? ''),
      deliveryFee: Number(z.deliveryFee ?? 0),
      freeShippingThreshold: (z.freeShippingThreshold as number | null) ?? null,
      estimatedDaysMin: (z.estimatedDaysMin as number | null) ?? null,
      estimatedDaysMax: (z.estimatedDaysMax as number | null) ?? null,
      estimatedDays: (z.estimatedDays as number | null) ?? null,
    }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Add the opts parameter to `productJsonLd`**

Change the signature in `structured-data.ts`:

```ts
export function productJsonLd(
  product: ProductForJsonLd,
  store: ResolvedStore,
  opts?: { shippingZones?: PublicShippingZone[] }
) {
```

and add inside `offers`, after `seller`:

```ts
      ...(opts?.shippingZones?.length
        ? (() => {
            const sd = shippingDetailsJsonLd(opts.shippingZones, { currency: store.currency });
            return sd ? { shippingDetails: sd } : {};
          })()
        : {}),
```

- [ ] **Step 3: Write the failing wiring test**

Append to the test file:

```ts
it('nests shippingDetails inside offers when zones are supplied', () => {
  const zones = [
    {
      name: 'Kuwait City',
      deliveryFee: 1500,
      freeShippingThreshold: null,
      estimatedDaysMin: 1,
      estimatedDaysMax: 2,
      estimatedDays: null,
    },
  ];
  const ld = productJsonLd(product, store, { shippingZones: zones }) as never as {
    offers: Record<string, unknown>;
  };
  expect(ld.offers.shippingDetails).toMatchObject({ '@type': 'OfferShippingDetails' });
});

it('omits shippingDetails when no zones are supplied', () => {
  const ld = productJsonLd(product, store) as never as { offers: Record<string, unknown> };
  expect(ld.offers).not.toHaveProperty('shippingDetails');
});
```

- [ ] **Step 4: Run tests**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Thread zones through the PDP**

In `ProductDetailBody.tsx`, add the import:

```ts
import { fetchPublicShippingZones } from '../../../lib/shipping-public';
```

Change the `Promise.all` (currently lines 154-157) to:

```ts
const [initialProduct, layout, shippingZones] = await Promise.all([
  fetchInitialProduct(slug, store),
  fetchProductDetailLayoutSettings(store.id, draftToken),
  fetchPublicShippingZones(store.id),
]);
```

and change the `productJsonLd` call inside `jsonLdScripts` to pass them:

```ts
        productJsonLd(
          {
            ...initialProduct,
            reviews: reviewsForJsonLd.length > 0 ? reviewsForJsonLd : undefined,
            aggregateRating: aggregateRatingForJsonLd,
          },
          store,
          { shippingZones }
        ),
```

- [ ] **Step 6: Verify typecheck is clean for touched files**

Run: `cd apps/web && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "structured-data|shipping-public|ProductDetailBody"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/shipping-public.ts apps/web/src/lib/structured-data.ts \
        "apps/web/src/app/products/[slug]/ProductDetailBody.tsx" \
        apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts
git commit -m "feat(seo): emit offer shipping details on product pages"
```

---

### Task 4: Return-policy config + `hasMerchantReturnPolicy`

**Why this task is bigger:** unlike brand and shipping, **no return-window data exists** anywhere in the schema. It cannot be derived — a return window is a merchant policy commitment. So this task adds the columns, the admin control to set them, the API passthrough, and the JSON-LD, and emits nothing until a merchant opts in.

**Files:**

- Modify: `packages/database/prisma/schema.prisma` (`model Store`)
- Create: `packages/database/prisma/migrations/<timestamp>_store_return_policy/migration.sql`
- Modify: `apps/api/src/routes/public.routes.ts:1213` and `:1407` (both store-resolve selects)
- Modify: `apps/web/src/lib/store-resolver.ts` (`ResolvedStore`)
- Modify: `apps/web/src/lib/structured-data.ts`
- Create: `apps/admin/src/app/stores/[id]/shipping/_components/ReturnPolicyCard.tsx`
- Test: `apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts`

**Interfaces:**

- Consumes: `ResolvedStore` (Task 3 unchanged fields).
- Produces: `merchantReturnPolicyJsonLd(store): object | null`; `Store.returnWindowDays: Int?`, `Store.returnFeesPaidBy: String?`.

- [ ] **Step 1: Add the schema columns**

In `model Store` in `schema.prisma`, next to the other policy fields:

```prisma
  /// Merchant return window in days. NULL = merchant has not declared one, and
  /// the storefront then omits hasMerchantReturnPolicy from Product JSON-LD
  /// entirely. NEVER default this: publishing a return window the merchant
  /// never agreed to is a false claim about their business to Google and to
  /// buying agents.
  returnWindowDays Int?    @map("return_window_days")
  /// Who pays return shipping: 'merchant' | 'customer'. NULL when unset.
  returnFeesPaidBy String? @map("return_fees_paid_by")
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name store_return_policy --schema packages/database/prisma/schema.prisma --create-only`
Then inspect the generated SQL — it must be exactly two `ADD COLUMN` statements, both nullable, no `DEFAULT`, no table rewrite.

- [ ] **Step 3: Write the failing JSON-LD test**

Append to the test file:

```ts
describe('merchantReturnPolicyJsonLd', () => {
  it('returns null when the merchant declared no window', () => {
    const ld = productJsonLd(product, store) as Record<string, unknown>;
    expect(ld).not.toHaveProperty('hasMerchantReturnPolicy');
  });

  it('emits the policy when a window is set', () => {
    const s = { ...(store as object), returnWindowDays: 14, returnFeesPaidBy: 'customer' } as never;
    const ld = productJsonLd(product, s) as Record<string, unknown>;
    expect(ld.hasMerchantReturnPolicy).toMatchObject({
      '@type': 'MerchantReturnPolicy',
      merchantReturnDays: 14,
      returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
      returnFees: 'https://schema.org/ReturnShippingFees',
    });
  });

  it('marks a 0-day window as no-returns rather than a 0-day window', () => {
    const s = { ...(store as object), returnWindowDays: 0 } as never;
    const ld = productJsonLd(product, s) as Record<string, unknown>;
    expect(ld.hasMerchantReturnPolicy).toMatchObject({
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts`
Expected: FAIL on the second test — `expected undefined to match object`

- [ ] **Step 5: Implement the emitter**

In `structured-data.ts`:

```ts
/**
 * schema.org MerchantReturnPolicy.
 *
 * Emitted ONLY when the merchant explicitly declared a window. `null` (unset)
 * and 0 mean different things and must not be collapsed: unset = "we have not
 * said", which omits the block; 0 = "we do not accept returns", which is a real,
 * publishable policy.
 */
export function merchantReturnPolicyJsonLd(
  store: Pick<ResolvedStore, 'returnWindowDays' | 'returnFeesPaidBy'>
) {
  const days = store.returnWindowDays;
  if (days === null || days === undefined) return null;

  if (days === 0) {
    return {
      '@type': 'MerchantReturnPolicy',
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    };
  }

  return {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'KW',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: days,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees:
      store.returnFeesPaidBy === 'merchant'
        ? 'https://schema.org/FreeReturn'
        : 'https://schema.org/ReturnShippingFees',
  };
}
```

Wire it into `productJsonLd`, after the `brand` line:

```ts
    ...(merchantReturnPolicyJsonLd(store)
      ? { hasMerchantReturnPolicy: merchantReturnPolicyJsonLd(store) }
      : {}),
```

Add both fields to `ResolvedStore` in `store-resolver.ts`:

```ts
  // Return policy — powers hasMerchantReturnPolicy in Product JSON-LD.
  // NULL means the merchant never declared one; the storefront then omits
  // the block rather than publishing a guess. Keep in lock-step with the
  // API select in public.routes.ts.
  returnWindowDays?: number | null;
  returnFeesPaidBy?: string | null;
```

- [ ] **Step 6: Run tests**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 7: Add the fields to BOTH store-resolve selects**

In `apps/api/src/routes/public.routes.ts`, next to `locationsEnabled: true,` at **both** line 1213 and line 1407 (missing one leaves custom-domain stores silently without the field — the exact class of bug `feedback-env-precedence-dead-branch` records):

```ts
          returnWindowDays: true,
          returnFeesPaidBy: true,
```

- [ ] **Step 8: Build the admin control**

Create `apps/admin/src/app/stores/[id]/shipping/_components/ReturnPolicyCard.tsx`:

```tsx
'use client';

import { useState } from 'react';

/**
 * Return-policy control. Feeds Product JSON-LD's hasMerchantReturnPolicy, so
 * empty MUST stay meaningfully empty: leaving the window blank publishes no
 * claim at all, while 0 publishes "returns not accepted". The copy says so,
 * because a merchant picking a number here is making a public commitment.
 */
export function ReturnPolicyCard({
  initialDays,
  initialFeesPaidBy,
  onSave,
}: {
  initialDays: number | null;
  initialFeesPaidBy: string | null;
  onSave: (v: {
    returnWindowDays: number | null;
    returnFeesPaidBy: string | null;
  }) => Promise<void>;
}) {
  const [days, setDays] = useState<string>(initialDays === null ? '' : String(initialDays));
  const [feesPaidBy, setFeesPaidBy] = useState<string>(initialFeesPaidBy ?? 'customer');
  const [saving, setSaving] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">Return policy</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Shown to Google and to AI shopping assistants. Leave the window empty to publish no return
        policy at all. Enter 0 to publish “returns not accepted”.
      </p>

      <label className="mt-3 block text-xs font-medium">Return window (days)</label>
      <input
        type="number"
        min={0}
        value={days}
        onChange={e => setDays(e.target.value)}
        placeholder="Not declared"
        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />

      <label className="mt-3 block text-xs font-medium">Return shipping paid by</label>
      <select
        value={feesPaidBy}
        onChange={e => setFeesPaidBy(e.target.value)}
        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      >
        <option value="customer">Customer</option>
        <option value="merchant">Merchant (free returns)</option>
      </select>

      <button
        type="button"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            const trimmed = days.trim();
            await onSave({
              returnWindowDays: trimmed === '' ? null : Number(trimmed),
              returnFeesPaidBy: trimmed === '' ? null : feesPaidBy,
            });
          } finally {
            setSaving(false);
          }
        }}
        className="mt-4 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save return policy'}
      </button>
    </div>
  );
}
```

Mount it on the existing shipping settings page (`apps/admin/src/app/stores/[id]/shipping/page.tsx`), wiring `onSave` to the store-update call that page already uses for its other settings.

- [ ] **Step 9: Verify the whole chain end-to-end**

Run: `./node_modules/.bin/vitest run apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts` — expect 11 passing.
Then confirm the admin surface renders and the value round-trips: open `/stores/<id>/shipping`, set the window to 14, save, reload, and confirm it persists (CLAUDE.md's "every data has a UI" PR test-plan requirement).

- [ ] **Step 10: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations \
        apps/api/src/routes/public.routes.ts apps/web/src/lib/store-resolver.ts \
        apps/web/src/lib/structured-data.ts \
        "apps/admin/src/app/stores/[id]/shipping/_components/ReturnPolicyCard.tsx" \
        "apps/admin/src/app/stores/[id]/shipping/page.tsx" \
        apps/web/src/lib/__tests__/structured-data-agent-fields.test.ts
git commit -m "feat(seo): add merchant return policy config and json-ld"
```

---

### Task 5: Validate, document, ship

**Files:**

- Modify: `docs/audits/2026-07-31-vibecoded-security-holes.md` (lens W follow-up note)
- Modify: `docs/architecture/store-theme-flags.md` (record the two new Store columns)

- [ ] **Step 1: Validate the emitted markup against Google**

Deploy the branch preview (or run `npm run dev:web`), open a product page, copy the `application/ld+json` block, and paste it into the [Rich Results Test](https://search.google.com/test/rich-results). Expected: **zero errors**; warnings about optional merchant-listing fields are acceptable.

- [ ] **Step 2: Confirm escaping still holds**

The JSON-LD escaping fix (PR #977) must survive the new fields — brand and shipping names are merchant-controlled strings.

Run: `./node_modules/.bin/vitest run apps/web/src/lib/__tests__/json-ld-script.test.ts`
Expected: PASS (6 tests). Then confirm on the deployed page that no raw `<` or `>` appears inside any ld+json block.

- [ ] **Step 3: Blast-radius sweep (Rule D-GATE — state the result)**

```bash
grep -rn "productJsonLd" apps/web/src            # every caller passes/omits opts safely
grep -rn "returnWindowDays\|returnFeesPaidBy" apps packages   # schema, both selects, resolver, admin, JSON-LD
grep -rn "locationsEnabled" apps/api/src/routes/public.routes.ts  # both selects touched, none missed
```

Expected: every `productJsonLd` caller compiles (opts is optional); `returnWindowDays` appears in schema + migration + **both** public selects + `ResolvedStore` + emitter + admin UI. State the result in the PR and in the final reply.

- [ ] **Step 4: Update docs**

Add to `docs/architecture/store-theme-flags.md` under the Store-columns section: `returnWindowDays` / `returnFeesPaidBy` — nullable, no default, drive `hasMerchantReturnPolicy`; unset omits the block, 0 means returns not accepted.

Add a "Lens W follow-up" line to the audit doc pointing at this plan and the resulting PR.

- [ ] **Step 5: Open the PR and babysit to merge**

```bash
gh pr create --title "feat(seo): agent-readable product json-ld (brand, shipping, returns)" --body "<summary, test plan, blast-radius result>"
```

Then merge once green, run `worktree-cleanup.sh`, and confirm the deployed product page emits the new fields with a fresh `curl -H 'Cache-Control: no-cache'`.

---

## Self-Review

**Spec coverage:** brand → Task 1. shippingDetails → Tasks 2 (emitter) + 3 (data + wiring). hasMerchantReturnPolicy → Task 4 (schema + API + resolver + UI + emitter). Validation/docs/ship → Task 5. No lens-W item is unassigned.

**Placeholder scan:** every code step carries real code; the only deliberately deferred detail is the `onSave` wiring in Task 4 Step 8, which must match whatever store-update helper the existing shipping page already uses — reading that page is part of the step.

**Type consistency:** `PublicShippingZone` is defined once in `structured-data.ts` (Task 2) and imported by `shipping-public.ts` (Task 3). `productJsonLd`'s third parameter is `opts?: { shippingZones?: PublicShippingZone[] }` in both the definition (Task 3 Step 2) and its call site (Task 3 Step 5). `merchantReturnPolicyJsonLd` reads `returnWindowDays`/`returnFeesPaidBy`, the same names added to `ResolvedStore`, the Prisma model, and both API selects.

**Known risk:** Task 4 touches `model Store`, so `prisma generate` must run before typecheck (CI already does this; locally the stale client shows ~146 pre-existing errors — compare counts against `main` rather than reading them as new).
