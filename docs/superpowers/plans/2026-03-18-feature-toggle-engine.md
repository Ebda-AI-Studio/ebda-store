# Feature Toggle Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-store feature flag system where super_admin manually enables/disables features per store, with full API gating, admin UI toggles, and storefront hiding.

**Architecture:** New `StoreFeature` DB table with `(storeId, featureKey)` unique pairs. Feature registry in `@ebda/shared`. `requireFeature()` middleware on API routes. Redis-cached lookups. Features tab on admin store detail page. Storefront reads features from existing store data endpoint.

**Tech Stack:** Prisma (PostgreSQL), Express.js middleware, Redis caching, React (Next.js App Router), Zod validation, Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-feature-toggle-engine-design.md`

---

## File Structure

**New files:**
| File | Responsibility |
|------|---------------|
| `packages/shared/src/features.ts` | Feature registry — keys, names, categories, Zod schema |
| `apps/api/src/services/feature.service.ts` | CRUD + cache for store features |
| `apps/api/src/middleware/feature-gate.ts` | `requireFeature()` Express middleware |
| `apps/api/src/routes/feature.routes.ts` | Super admin feature management endpoints |
| `apps/admin/src/hooks/useFeatures.ts` | Admin-side feature hook (fetches for current store) |
| `apps/admin/src/app/stores/[id]/features/page.tsx` | Features tab UI (super_admin only) |
| `apps/web/src/contexts/FeatureContext.tsx` | Storefront feature context + `useFeatures()` hook |
| `tests/unit/feature.test.ts` | Unit tests for feature service + middleware |

**Modified files:**
| File | Change |
|------|--------|
| `packages/database/prisma/schema.prisma` | Add `StoreFeature` model, relations on Store + User |
| `packages/shared/src/types/index.ts` | Add `enabledFeatures` to Store interface |
| `apps/api/src/routes/index.ts` | Import + mount feature routes |
| `apps/api/src/routes/coupon.routes.ts` | Add `requireFeature('coupons')` |
| `apps/api/src/routes/loyalty.routes.ts` | Add `requireFeature('loyalty')` |
| `apps/api/src/routes/return.routes.ts` | Add `requireFeature('returns')` |
| `apps/api/src/routes/review.routes.ts` | Add `requireFeature('reviews')` |
| `apps/api/src/routes/inventory.routes.ts` | Add `requireFeature('inventory')` |
| `apps/api/src/routes/tax.routes.ts` | Add `requireFeature('tax')` |
| `apps/api/src/routes/bulk.routes.ts` | Add `requireFeature('bulk_operations')` |
| `apps/api/src/routes/pwa.routes.ts` | Add `requireFeature('pwa')` |
| `apps/api/src/routes/shipping.routes.ts` | Add `requireFeature('shipping_carriers')` to carrier-specific routes |
| `apps/api/src/routes/public.routes.ts` | Include `enabledFeatures` in store response |
| `apps/api/src/services/store.service.ts` | Add feature loading to getBySlug/getByDomain |
| `apps/admin/src/app/stores/[id]/page.tsx` | Add "Features" tab link |
| `apps/admin/src/components/AdminLayout.tsx` | Gate sidebar links with feature checks |
| `apps/admin/src/app/stores/[id]/settings/page.tsx` | Gate settings cards |
| `apps/web/src/app/layout.tsx` | Wrap with `FeatureProvider` |
| `apps/web/src/contexts/StoreContext.tsx` | Pass `enabledFeatures` through |
| `apps/web/src/app/cart/CartClient.tsx` | Gate coupon input |
| `apps/web/src/app/products/[slug]/ProductDetailClient.tsx` | Gate reviews section |
| `apps/web/src/components/MarketingPixels.tsx` | Gate pixel rendering |
| `apps/web/src/app/account/` layout or sidebar | Gate loyalty, returns links |

---

## Task 1: Feature Registry in @ebda/shared

**Files:**

- Create: `packages/shared/src/features.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Create the feature registry file**

Create `packages/shared/src/features.ts` with all feature keys, definitions, categories, and Zod validation schema. Use the exact content from the spec's Feature Registry section. Include:

- `FeatureKey` union type
- `FeatureCategory` union type
- `FeatureDefinition` interface (key, name, nameAr, description, descriptionAr, category)
- `FEATURE_REGISTRY` const object with all 21 features
- `FEATURE_KEYS` array
- `FEATURE_CATEGORIES` / `FEATURE_CATEGORIES_AR` display name maps
- `featureKeySchema` — Zod enum for validating input keys
- `featureUpdatesSchema` — Zod record schema for bulk updates: `z.record(featureKeySchema, z.boolean())`

```typescript
import { z } from 'zod';

export const FEATURE_KEYS_ARRAY = [
  'coupons',
  'loyalty',
  'returns',
  'reviews',
  'inventory',
  'tax',
  'bulk_operations',
  'customer_wallet',
  'upsell_crosssell',
  'whatsapp',
  'sms',
  'push_notifications',
  'email_campaigns',
  'abandoned_cart',
  'affiliate',
  'marketing_pixels',
  'shipping_carriers',
  'staff_accounts',
  'pwa',
  'seo',
  'search_autocomplete',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS_ARRAY)[number];

export const featureKeySchema = z.enum(FEATURE_KEYS_ARRAY);
export const featureUpdatesSchema = z
  .record(featureKeySchema, z.boolean())
  .refine(obj => Object.keys(obj).length > 0, { message: 'At least one feature must be provided' });
```

- [ ] **Step 2: Add `enabledFeatures` to Store type**

In `packages/shared/src/types/index.ts`, add to the `Store` interface (around line 42-69):

```typescript
enabledFeatures?: string[];
```

- [ ] **Step 3: Export from shared package barrel**

Check if `packages/shared/src/index.ts` exists. If so, add `export * from './features';`. If the package uses direct imports, skip this step.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/features.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): add feature registry with keys, definitions, and zod schemas"
```

---

## Task 2: Prisma Schema — StoreFeature Model

**Files:**

- Modify: `packages/database/prisma/schema.prisma`

- [ ] **Step 1: Add StoreFeature model**

Add after the existing models (after line ~855, near SystemSetting):

```prisma
model StoreFeature {
  id         String    @id @default(uuid())
  storeId    String    @map("store_id")
  featureKey String    @map("feature_key")
  enabled    Boolean   @default(false)
  enabledAt  DateTime? @map("enabled_at")
  enabledBy  String?   @map("enabled_by")
  updatedAt  DateTime  @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)
  user  User? @relation("FeatureToggledBy", fields: [enabledBy], references: [id], onDelete: SetNull)

  @@unique([storeId, featureKey])
  @@index([storeId])
  @@map("store_features")
}
```

- [ ] **Step 2: Add relations to Store model**

In the Store model relations section (around line 183-202), add:

```prisma
features   StoreFeature[]
```

- [ ] **Step 3: Add relation to User model**

In the User model relations section (around line 41-53), add:

```prisma
featureToggles StoreFeature[] @relation("FeatureToggledBy")
```

- [ ] **Step 4: Run prisma generate**

```bash
cd /Users/ahmadsharaf/Desktop/projects/force-website-builder
npm run db:generate
```

Expected: Prisma client regenerated successfully.

- [ ] **Step 5: Create migration**

```bash
cd /Users/ahmadsharaf/Desktop/projects/force-website-builder/packages/database
npx prisma migrate dev --name add_store_features
```

Expected: Migration created and applied to dev database.

- [ ] **Step 6: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/
git commit -m "feat(database): add store_features table for per-store feature toggles"
```

---

## Task 3: Feature Service

**Files:**

- Create: `apps/api/src/services/feature.service.ts`

- [ ] **Step 1: Write the feature service**

```typescript
import { prisma } from '@ebda/database';
import { redis } from './redis.service';
import { FeatureKey, FEATURE_KEYS_ARRAY } from '@ebda/shared/features';

const CACHE_PREFIX = 'features:store:';
const CACHE_TTL = 300; // 5 minutes

export class FeatureService {
  /**
   * Get all feature states for a store.
   * Returns a full map with every feature key (default false for missing rows).
   * Cached in Redis for 5 minutes.
   */
  async getStoreFeatures(storeId: string): Promise<Record<FeatureKey, boolean>> {
    // 1. Check Redis cache
    const cached = await this.getCached(storeId);
    if (cached) return cached;

    // 2. Cache miss — query DB
    const rows = await prisma.storeFeature.findMany({
      where: { storeId },
      select: { featureKey: true, enabled: true },
    });

    // 3. Build full map with defaults
    const map = {} as Record<FeatureKey, boolean>;
    for (const key of FEATURE_KEYS_ARRAY) {
      map[key] = false;
    }
    for (const row of rows) {
      if (FEATURE_KEYS_ARRAY.includes(row.featureKey as FeatureKey)) {
        map[row.featureKey as FeatureKey] = row.enabled;
      }
    }

    // 4. Cache and return
    await this.setCache(storeId, map);
    return map;
  }

  /**
   * Check if a single feature is enabled for a store.
   */
  async isFeatureEnabled(storeId: string, featureKey: FeatureKey): Promise<boolean> {
    const features = await this.getStoreFeatures(storeId);
    return features[featureKey] ?? false;
  }

  /**
   * Get only the enabled feature keys for a store (for public endpoint).
   */
  async getEnabledFeatureKeys(storeId: string): Promise<string[]> {
    const features = await this.getStoreFeatures(storeId);
    return Object.entries(features)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key);
  }

  /**
   * Bulk update features for a store. Upserts each key.
   * Sets cache with known-correct value (no DELETE-then-repopulate).
   */
  async updateStoreFeatures(
    storeId: string,
    updates: Partial<Record<FeatureKey, boolean>>,
    userId: string
  ): Promise<Record<FeatureKey, boolean>> {
    const now = new Date();

    // Upsert each feature in a transaction
    await prisma.$transaction(
      Object.entries(updates).map(([key, enabled]) =>
        prisma.storeFeature.upsert({
          where: {
            storeId_featureKey: { storeId, featureKey: key },
          },
          create: {
            storeId,
            featureKey: key,
            enabled: enabled!,
            enabledAt: enabled ? now : null,
            enabledBy: userId,
          },
          update: {
            enabled: enabled!,
            enabledAt: enabled ? now : null,
            enabledBy: userId,
          },
        })
      )
    );

    // Re-read all features and SET cache (avoid replica staleness)
    const allFeatures = await this.getStoreFeaturesFromDB(storeId);
    await this.setCache(storeId, allFeatures);

    return allFeatures;
  }

  /**
   * Set a single feature for a store (idempotent).
   */
  async setFeature(
    storeId: string,
    featureKey: FeatureKey,
    enabled: boolean,
    userId: string
  ): Promise<Record<FeatureKey, boolean>> {
    return this.updateStoreFeatures(storeId, { [featureKey]: enabled }, userId);
  }

  // --- Private helpers ---

  private async getStoreFeaturesFromDB(storeId: string): Promise<Record<FeatureKey, boolean>> {
    const rows = await prisma.storeFeature.findMany({
      where: { storeId },
      select: { featureKey: true, enabled: true },
    });

    const map = {} as Record<FeatureKey, boolean>;
    for (const key of FEATURE_KEYS_ARRAY) {
      map[key] = false;
    }
    for (const row of rows) {
      if (FEATURE_KEYS_ARRAY.includes(row.featureKey as FeatureKey)) {
        map[row.featureKey as FeatureKey] = row.enabled;
      }
    }
    return map;
  }

  private async getCached(storeId: string): Promise<Record<FeatureKey, boolean> | null> {
    try {
      // Use the same redis client pattern as store.service.ts
      if (!redis) return null;
      const data = await redis.get(`${CACHE_PREFIX}${storeId}`);
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private async setCache(storeId: string, features: Record<FeatureKey, boolean>): Promise<void> {
    try {
      if (!redis) return;
      await redis.set(`${CACHE_PREFIX}${storeId}`, JSON.stringify(features), 'EX', CACHE_TTL);
    } catch {
      // Cache failure is non-fatal
    }
  }
}

export const featureService = new FeatureService();
```

**IMPORTANT:** Before writing the file, read `apps/api/src/services/store.service.ts` to match the exact Redis import pattern and Prisma client import pattern used in this project. Adapt the imports accordingly.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/feature.service.ts
git commit -m "feat(api): add feature service with redis-cached store feature lookups"
```

---

## Task 4: requireFeature Middleware

**Files:**

- Create: `apps/api/src/middleware/feature-gate.ts`

- [ ] **Step 1: Write the middleware**

```typescript
import { Request, Response, NextFunction } from 'express';
import { FeatureKey } from '@ebda/shared/features';
import { featureService } from '../services/feature.service';

/**
 * Express middleware that blocks access when a feature is disabled for a store.
 * FAILS CLOSED: if storeId cannot be determined, access is denied.
 */
export function requireFeature(featureKey: FeatureKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Resolve storeId from multiple sources: URL params, middleware-attached store, or header
    const storeId =
      req.params.storeId ||
      req.params.id ||
      (req as any).store?.id ||
      (req.headers['x-store-id'] as string);

    // Fail closed — no store context means no access
    if (!storeId) {
      return res.status(403).json({
        success: false,
        error: 'Feature not available',
        code: 'FEATURE_DISABLED',
        feature: featureKey,
      });
    }

    try {
      const enabled = await featureService.isFeatureEnabled(storeId, featureKey);
      if (!enabled) {
        return res.status(403).json({
          success: false,
          error: 'Feature not available',
          code: 'FEATURE_DISABLED',
          feature: featureKey,
        });
      }
      next();
    } catch (error) {
      // On error, fail closed
      return res.status(403).json({
        success: false,
        error: 'Feature not available',
        code: 'FEATURE_DISABLED',
        feature: featureKey,
      });
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/middleware/feature-gate.ts
git commit -m "feat(api): add requireFeature middleware with fail-closed behavior"
```

---

## Task 5: Unit Tests for Feature Service + Middleware

**Files:**

- Create: `tests/unit/feature.test.ts`

- [ ] **Step 1: Write unit tests**

Follow the existing test pattern from `tests/unit/auth.test.ts` and `tests/setup.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMockRequest,
  createMockResponse,
  createMockNext,
  mockStore,
  mockAdmin,
} from '../setup';
import { FEATURE_KEYS_ARRAY, featureKeySchema, featureUpdatesSchema } from '@ebda/shared/features';

describe('Feature Toggle Engine', () => {
  describe('Feature Registry', () => {
    it('should have 21 feature keys', () => {
      expect(FEATURE_KEYS_ARRAY.length).toBe(21);
    });

    it('should validate known feature keys', () => {
      expect(featureKeySchema.safeParse('coupons').success).toBe(true);
      expect(featureKeySchema.safeParse('loyalty').success).toBe(true);
      expect(featureKeySchema.safeParse('whatsapp').success).toBe(true);
    });

    it('should reject unknown feature keys', () => {
      expect(featureKeySchema.safeParse('unknown_feature').success).toBe(false);
      expect(featureKeySchema.safeParse('').success).toBe(false);
      expect(featureKeySchema.safeParse(123).success).toBe(false);
    });

    it('should validate feature updates schema', () => {
      const valid = featureUpdatesSchema.safeParse({ coupons: true, loyalty: false });
      expect(valid.success).toBe(true);

      const invalid = featureUpdatesSchema.safeParse({ unknown: true });
      expect(invalid.success).toBe(false);

      const empty = featureUpdatesSchema.safeParse({});
      expect(empty.success).toBe(false);
    });
  });

  describe('requireFeature Middleware', () => {
    let requireFeature: any;

    beforeEach(async () => {
      // Reset modules to get fresh mocks
      vi.resetModules();

      // Mock the feature service
      vi.mock('../../apps/api/src/services/feature.service', () => ({
        featureService: {
          isFeatureEnabled: vi.fn(),
        },
      }));

      const mod = await import('../../apps/api/src/middleware/feature-gate');
      requireFeature = mod.requireFeature;
    });

    it('should call next() when feature is enabled', async () => {
      const { featureService } = await import('../../apps/api/src/services/feature.service');
      (featureService.isFeatureEnabled as any).mockResolvedValue(true);

      const req = createMockRequest({ params: { storeId: mockStore.id } });
      const res = createMockResponse();
      const next = createMockNext();

      await requireFeature('coupons')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should return 403 when feature is disabled', async () => {
      const { featureService } = await import('../../apps/api/src/services/feature.service');
      (featureService.isFeatureEnabled as any).mockResolvedValue(false);

      const req = createMockRequest({ params: { storeId: mockStore.id } });
      const res = createMockResponse();
      const next = createMockNext();

      await requireFeature('coupons')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'FEATURE_DISABLED', feature: 'coupons' })
      );
    });

    it('should fail closed when no storeId is available', async () => {
      const req = createMockRequest({ params: {} });
      const res = createMockResponse();
      const next = createMockNext();

      await requireFeature('coupons')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should fail closed on service error', async () => {
      const { featureService } = await import('../../apps/api/src/services/feature.service');
      (featureService.isFeatureEnabled as any).mockRejectedValue(new Error('DB down'));

      const req = createMockRequest({ params: { storeId: mockStore.id } });
      const res = createMockResponse();
      const next = createMockNext();

      await requireFeature('coupons')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd /Users/ahmadsharaf/Desktop/projects/force-website-builder
npx vitest run tests/unit/feature.test.ts
```

Expected: All tests pass. If module resolution fails for `@ebda/shared/features`, check the workspace alias configuration and adjust the import path.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/feature.test.ts
git commit -m "test(api): add unit tests for feature registry validation and requireFeature middleware"
```

---

## Task 6: Feature Management API Routes

**Files:**

- Create: `apps/api/src/routes/feature.routes.ts`
- Modify: `apps/api/src/routes/index.ts`

- [ ] **Step 1: Write the feature routes**

Read the existing route patterns first. Look at `apps/api/src/routes/admin.routes.ts` for the super_admin route pattern (authenticate + authorize). Create:

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { prisma } from '@ebda/database';
import { featureService } from '../services/feature.service';
import { featureKeySchema, featureUpdatesSchema, FEATURE_REGISTRY } from '@ebda/shared/features';

const router = Router();

// All feature routes require super_admin
router.use(authenticate);
router.use(authorize('super_admin'));

/**
 * GET /admin/stores/:id/features
 * Get all feature states for a store + registry metadata
 * requireStoreAccess ensures the store exists (prevents orphan rows)
 */
router.get(
  '/stores/:id/features',
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const features = await featureService.getStoreFeatures(id);

      // Include full feature rows for last-modified info
      const rows = await prisma.storeFeature.findMany({
        where: { storeId: id },
        select: {
          featureKey: true,
          enabled: true,
          enabledAt: true,
          enabledBy: true,
          updatedAt: true,
          user: { select: { firstName: true, lastName: true, email: true } },
        },
      });

      const metadata: Record<string, any> = {};
      for (const row of rows) {
        metadata[row.featureKey] = {
          enabledAt: row.enabledAt,
          enabledBy: row.user ? `${row.user.firstName} ${row.user.lastName}` : null,
          updatedAt: row.updatedAt,
        };
      }

      res.json({
        success: true,
        data: {
          features,
          metadata,
          registry: FEATURE_REGISTRY,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /admin/stores/:id/features
 * Bulk update features for a store
 */
router.put(
  '/stores/:id/features',
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const parsed = featureUpdatesSchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid feature updates',
          details: parsed.error.flatten(),
        });
      }

      const userId = (req as any).user.id;
      const features = await featureService.updateStoreFeatures(id, parsed.data, userId);

      res.json({
        success: true,
        data: { features },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /admin/stores/:id/features/:featureKey
 * Set a single feature (idempotent)
 */
router.put(
  '/stores/:id/features/:featureKey',
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, featureKey } = req.params;
      const keyParsed = featureKeySchema.safeParse(featureKey);

      if (!keyParsed.success) {
        return res.status(400).json({
          success: false,
          error: `Unknown feature key: ${featureKey}`,
        });
      }

      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'Request body must include { enabled: boolean }',
        });
      }

      const userId = (req as any).user.id;
      const features = await featureService.setFeature(id, keyParsed.data, enabled, userId);

      res.json({
        success: true,
        data: { features },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
```

**IMPORTANT:** Before writing, read the actual `authenticate` and `authorize` import paths from an existing route file (e.g., `apps/api/src/routes/admin.routes.ts`) and match them exactly. Also match the Prisma import pattern from existing services.

- [ ] **Step 2: Mount in routes/index.ts**

In `apps/api/src/routes/index.ts`, add import and mount:

```typescript
// After line 25 (last import):
import featureRoutes from './feature.routes';

// After line 43 (admin routes):
// Feature management (super_admin only, uses /admin prefix)
router.use('/admin', featureRoutes);
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/feature.routes.ts apps/api/src/routes/index.ts
git commit -m "feat(api): add super_admin feature management endpoints"
```

---

## Task 7: Embed Features in Public Store Endpoint

**Files:**

- Modify: `apps/api/src/routes/public.routes.ts` (lines 427-488)

- [ ] **Step 1: Read the current public store endpoint**

Read `apps/api/src/routes/public.routes.ts` lines 427-488 to see the exact current implementation.

- [ ] **Step 2: Add enabledFeatures to the response**

After the store is fetched (around line 471), add:

```typescript
// After the store query, before sending response:
const { featureService } = require('../services/feature.service');
const enabledFeatures = await featureService.getEnabledFeatureKeys(store.id);

// In the response object, add:
// enabledFeatures,
```

Add `enabledFeatures` to the response JSON alongside the existing store fields. Do NOT restructure the existing response — just add the field.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/public.routes.ts
git commit -m "feat(api): include enabledFeatures in public store endpoint response"
```

---

## Task 8: Migrate Existing Boolean Flags (BEFORE gating routes)

> **Do this BEFORE Task 9 (route gating) to avoid a double-gating window.**

**Files:**

- Modify: Any service that reads `store.taxEnabled`, `store.loyaltyEnabled`, `store.pwaEnabled`

- [ ] **Step 1: Find all usages of the old boolean flags**

```bash
cd /Users/ahmadsharaf/Desktop/projects/force-website-builder
grep -rn "taxEnabled\|loyaltyEnabled\|pwaEnabled" --include="*.ts" --include="*.tsx" apps/ packages/
```

- [ ] **Step 2: Replace each usage with featureService.isFeatureEnabled()**

For API services: replace `store.loyaltyEnabled` with `await featureService.isFeatureEnabled(storeId, 'loyalty')`.

For frontend components: replace with `useFeatures().isEnabled('loyalty')`.

- [ ] **Step 3: Create a data migration script**

Create `scripts/migrate-feature-flags.ts`:

```typescript
// For each store:
//   if store.taxEnabled → upsert StoreFeature(storeId, 'tax', true)
//   if store.loyaltyEnabled → upsert StoreFeature(storeId, 'loyalty', true)
//   if store.pwaEnabled → upsert StoreFeature(storeId, 'pwa', true)
```

Use `import { prisma } from '@ebda/database'` (same import as all services).

- [ ] **Step 4: Run the migration script**

```bash
npx tsx scripts/migrate-feature-flags.ts
```

- [ ] **Step 5: Remove old columns from schema**

Remove `taxEnabled`, `loyaltyEnabled`, `pwaEnabled` from the Store model in schema.prisma (lines 171, 176, 180). Run:

```bash
cd packages/database
npx prisma migrate dev --name remove_legacy_feature_booleans
```

- [ ] **Step 6: Commit**

```bash
git add packages/database/prisma/ apps/ scripts/
git commit -m "refactor(database): migrate legacy feature booleans to store_features table"
```

---

## Task 9: Apply requireFeature to Existing Route Files

**Files:**

- Modify: 10 route files (add one line each)

- [ ] **Step 1: Read each route file's first 10 lines to understand the import pattern**

Read the top of each file to see how middleware is imported. Then add the `requireFeature` import and usage.

- [ ] **Step 2: Add requireFeature to each toggleable route file**

For each file, add at the top (after existing imports):

```typescript
import { requireFeature } from '../middleware/feature-gate';
```

Then add `router.use(requireFeature('FEATURE_KEY'));` as the first middleware in the chain.

**Files and their feature keys:**

| File                                      | Feature Key           | Where to add `router.use()`                                            |
| ----------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `apps/api/src/routes/coupon.routes.ts`    | `'coupons'`           | After router creation, before first route                              |
| `apps/api/src/routes/loyalty.routes.ts`   | `'loyalty'`           | After router creation, before first route                              |
| `apps/api/src/routes/return.routes.ts`    | `'returns'`           | After router creation, before first route                              |
| `apps/api/src/routes/review.routes.ts`    | `'reviews'`           | After router creation, before first route                              |
| `apps/api/src/routes/inventory.routes.ts` | `'inventory'`         | After router creation, before first route                              |
| `apps/api/src/routes/tax.routes.ts`       | `'tax'`               | After router creation, before first route                              |
| `apps/api/src/routes/bulk.routes.ts`      | `'bulk_operations'`   | After router creation, before first route                              |
| `apps/api/src/routes/pwa.routes.ts`       | `'pwa'`               | After router creation, before first route                              |
| `apps/api/src/routes/shipping.routes.ts`  | `'shipping_carriers'` | Only on carrier-integration-specific routes (NOT basic shipping zones) |

**Marketing Pixels:** Marketing pixel endpoints live inside `store.routes.ts` (the `PUT /:id/marketing-pixels` endpoint), NOT in a separate file. Add `requireFeature('marketing_pixels')` as per-endpoint middleware on that specific route handler inside `store.routes.ts`.

**IMPORTANT:** Some route files have BOTH admin and public endpoints (e.g., coupon.routes has a public validate endpoint). Read each file carefully:

- If ALL routes are store-admin-only, add `router.use(requireFeature(...))` at the top.
- If the file has public endpoints too, add `requireFeature(...)` only to the admin route handlers, not to the public ones. The public routes may need individual `requireFeature()` calls.

**Do NOT gate these files** (they are always-on or non-store-scoped):

- `product.routes.ts` (core feature)
- `category.routes.ts` (core feature)
- `order.routes.ts` (core feature)
- `cart.routes.ts` (core feature)
- `store.routes.ts` (core feature)
- `auth.routes.ts` (core feature)
- `admin.routes.ts` (super admin)
- `analytics.routes.ts` (core feature)
- `payment.routes.ts` (core feature)
- `upload.routes.ts` (utility)
- `webhook.routes.ts` (payment webhooks)
- `address.routes.ts` (core feature)
- `variant.routes.ts` (core feature)

- [ ] **Step 3: Gate coupon codes and loyalty in order creation**

Read `apps/api/src/routes/public.routes.ts` — find the order creation endpoint (`POST /public/orders` or similar). Inside the handler (or the order service it calls), add logic to:

- If `coupons` feature is disabled for this store, strip/ignore the `couponCode` field from the request body before processing
- If `loyalty` feature is disabled, skip loyalty point redemption/earning

This prevents blocking checkout entirely while ensuring disabled features can't be used.

```typescript
// Inside order creation handler or service:
const couponsEnabled = await featureService.isFeatureEnabled(storeId, 'coupons');
if (!couponsEnabled) {
  delete orderData.couponCode;
}
const loyaltyEnabled = await featureService.isFeatureEnabled(storeId, 'loyalty');
// Skip loyalty point operations if disabled
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/coupon.routes.ts apps/api/src/routes/loyalty.routes.ts \
  apps/api/src/routes/return.routes.ts apps/api/src/routes/review.routes.ts \
  apps/api/src/routes/inventory.routes.ts apps/api/src/routes/tax.routes.ts \
  apps/api/src/routes/bulk.routes.ts apps/api/src/routes/pwa.routes.ts \
  apps/api/src/routes/shipping.routes.ts apps/api/src/routes/store.routes.ts \
  apps/api/src/routes/public.routes.ts
git commit -m "feat(api): gate toggleable routes with requireFeature middleware"
```

---

## Task 9: Admin UI — Features Tab

**Files:**

- Create: `apps/admin/src/app/stores/[id]/features/page.tsx`
- Modify: `apps/admin/src/app/stores/[id]/page.tsx` (add tab link)

- [ ] **Step 1: Read the existing store detail page**

Read `apps/admin/src/app/stores/[id]/page.tsx` to understand the component structure, API call patterns, styling classes, and how tabs/links are rendered.

- [ ] **Step 2: Create the Features page**

Create `apps/admin/src/app/stores/[id]/features/page.tsx`:

This page should:

1. Be a `'use client'` component
2. Fetch `GET /admin/stores/${storeId}/features` on mount using the project's `apiGet` pattern (check `apps/admin/src/lib/api.ts`)
3. Display features grouped by category (Commerce, Marketing, Operations, Storefront)
4. Each feature: name + description + toggle switch
5. Track dirty state (which features were changed)
6. "Save Changes" button that calls `PUT /admin/stores/${storeId}/features` with only changed features
7. Show success/error toast (match existing toast pattern)
8. Show metadata (last enabled by, when) for each enabled feature
9. Follow the project's existing styling patterns (Tailwind classes, card layouts)

**CRITICAL:** Read existing admin pages (e.g., `apps/admin/src/app/stores/[id]/settings/page.tsx` or the loyalty page) to match the exact UI patterns, API client usage, toast pattern, and Tailwind class conventions. Do NOT invent a new UI style.

- [ ] **Step 3: Add Features link on store detail page**

In `apps/admin/src/app/stores/[id]/page.tsx`, add a "Manage Features" card/link in the Quick Actions section (around line 624-756). This should link to `/stores/${storeId}/features` and only be visible to super_admin users.

- [ ] **Step 4: Verify the page renders**

Start the admin dev server and navigate to `/stores/{some-store-id}/features`. Verify:

- Features are grouped by category
- Toggles work
- Save updates the backend
- Toast shows on success

```bash
cd /Users/ahmadsharaf/Desktop/projects/force-website-builder
npm run dev:admin
```

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/app/stores/[id]/features/page.tsx apps/admin/src/app/stores/[id]/page.tsx
git commit -m "feat(admin): add features management page for super_admin store control"
```

---

## Task 10: Admin Sidebar Feature Gating

**Files:**

- Create: `apps/admin/src/hooks/useFeatures.ts`
- Modify: `apps/admin/src/components/AdminLayout.tsx`
- Modify: `apps/admin/src/app/stores/[id]/settings/page.tsx`

- [ ] **Step 1: Read AdminLayout.tsx and settings page**

Read `apps/admin/src/components/AdminLayout.tsx` (especially lines 40-73 for store admin nav) and `apps/admin/src/app/stores/[id]/settings/page.tsx` to understand the current navigation and settings card patterns.

- [ ] **Step 2: Create useFeatures hook for admin**

```typescript
// apps/admin/src/hooks/useFeatures.ts
'use client';

import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { apiGet } from '../lib/api';

interface FeatureState {
  features: Record<string, boolean>;
  isEnabled: (key: string) => boolean;
  isLoading: boolean;
}

const FeatureContext = createContext<FeatureState>({
  features: {},
  isEnabled: () => false,
  isLoading: true,
});

export function AdminFeatureProvider({
  children,
  storeId,
}: {
  children: React.ReactNode;
  storeId: string | null;
}) {
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!storeId) {
      setFeatures({});
      setIsLoading(false);
      return;
    }

    apiGet(`/admin/stores/${storeId}/features`)
      .then((res: any) => {
        if (res.success) {
          setFeatures(res.data.features);
        }
      })
      .catch(() => {
        // Fail open for super_admin viewing — they can still navigate
        setFeatures({});
      })
      .finally(() => setIsLoading(false));
  }, [storeId]);

  const isEnabled = useCallback(
    (key: string) => features[key] ?? false,
    [features]
  );

  return (
    <FeatureContext.Provider value={{ features, isEnabled, isLoading }}>
      {children}
    </FeatureContext.Provider>
  );
}

export const useFeatures = () => useContext(FeatureContext);
```

**CRITICAL:** The `/admin/stores/:id/features` endpoint requires super_admin. Store admins will get 403, causing all features to appear disabled. Fix this by:

1. Adding a NEW endpoint: `GET /stores/:storeId/my-features` — requires `authenticate` + `requireStoreAccess` (no super_admin check). Returns only the `features` map (no metadata/registry). Add this to `feature.routes.ts`.
2. In the `AdminFeatureProvider`, detect the user's role from auth context. If `super_admin`, call `/admin/stores/:id/features`. If `store_admin`, call `/stores/:storeId/my-features`.
3. Read the existing auth context pattern in the admin app (`apps/admin/src/lib/auth.tsx`) to get the current user's role.

- [ ] **Step 3: Gate sidebar navigation links**

In `AdminLayout.tsx`, wrap store-admin nav items with feature checks:

```typescript
// The buildStoreAdminNav function (lines 40-73) should conditionally include items:
// Only include Settings subsections that are enabled
// For example, if store_admin:
//   - Always show: Dashboard, Products, Orders, Customers, Analytics, Settings
//   - Conditionally in settings: Coupons, Loyalty, Returns, Reviews, etc.
```

The sidebar items that need gating are the ones under Settings, not the top-level nav. Read the actual sidebar structure to determine the right place to add conditions.

- [ ] **Step 4: Gate settings page cards**

In `apps/admin/src/app/stores/[id]/settings/page.tsx`, wrap each feature-dependent settings card with:

```tsx
{isEnabled('coupons') && <SettingsCard title="Coupons" ... />}
{isEnabled('loyalty') && <SettingsCard title="Loyalty Program" ... />}
// etc.
```

Read the file first to see the exact card pattern.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/hooks/useFeatures.ts apps/admin/src/components/AdminLayout.tsx \
  apps/admin/src/app/stores/[id]/settings/page.tsx
git commit -m "feat(admin): gate sidebar and settings with feature flags"
```

---

## Task 11: Web Storefront — Feature Context + Gating

**Files:**

- Create: `apps/web/src/contexts/FeatureContext.tsx`
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/contexts/StoreContext.tsx`

- [ ] **Step 1: Read layout.tsx and StoreContext.tsx**

Read these files to understand exactly how the store data flows from server to client.

- [ ] **Step 2: Pass enabledFeatures through StoreContext**

In `apps/web/src/contexts/StoreContext.tsx`, the `initialStore` prop now includes `enabledFeatures` (from the public store endpoint we modified in Task 7). Make it available:

```typescript
// In the StoreContext value, add:
enabledFeatures: store?.enabledFeatures || [],
```

Update the context type to include `enabledFeatures: string[]`.

- [ ] **Step 3: Create FeatureContext**

Create `apps/web/src/contexts/FeatureContext.tsx`:

```typescript
'use client';

import { createContext, useContext, useMemo, useCallback } from 'react';
import { useStore } from './StoreContext';

interface FeatureContextValue {
  isEnabled: (key: string) => boolean;
  features: Set<string>;
}

const FeatureContext = createContext<FeatureContextValue>({
  isEnabled: () => false,
  features: new Set(),
});

export function FeatureProvider({ children }: { children: React.ReactNode }) {
  const { enabledFeatures } = useStore();
  const features = useMemo(() => new Set(enabledFeatures || []), [enabledFeatures]);
  const isEnabled = useCallback((key: string) => features.has(key), [features]);

  return (
    <FeatureContext.Provider value={{ isEnabled, features }}>
      {children}
    </FeatureContext.Provider>
  );
}

export const useFeatures = () => useContext(FeatureContext);
```

- [ ] **Step 4: Add FeatureProvider in layout.tsx**

In `apps/web/src/app/layout.tsx`, wrap children inside `StoreProvider` with `FeatureProvider`:

```tsx
<StoreProvider initialStore={store}>
  <FeatureProvider>
    <AuthProvider>...</AuthProvider>
  </FeatureProvider>
</StoreProvider>
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/contexts/FeatureContext.tsx apps/web/src/contexts/StoreContext.tsx \
  apps/web/src/app/layout.tsx
git commit -m "feat(web): add FeatureProvider for storefront feature gating"
```

---

## Task 12: Storefront UI Gating

**Files:**

- Modify: `apps/web/src/app/cart/CartClient.tsx`
- Modify: `apps/web/src/app/products/[slug]/ProductDetailClient.tsx`
- Modify: `apps/web/src/components/MarketingPixels.tsx`
- Modify: `apps/web/src/components/Header.tsx` (if it has feature-dependent links)
- Modify: Account pages layout/sidebar (if it has loyalty/returns links)

- [ ] **Step 1: Read each file to understand what to gate**

Read the following files and note exactly what sections need gating:

- `CartClient.tsx` — find the coupon/promo code input section
- `ProductDetailClient.tsx` — find the ReviewSection component usage
- `MarketingPixels.tsx` — find where it renders pixel scripts
- Header and account pages — find links to loyalty, returns, reviews

- [ ] **Step 2: Gate coupon input in cart**

In `CartClient.tsx`, wrap the promo code section:

```tsx
import { useFeatures } from '../../contexts/FeatureContext';
// ...
const { isEnabled } = useFeatures();
// ...
{
  isEnabled('coupons') && (
    <div className="...promo code section...">{/* existing promo code input */}</div>
  );
}
```

- [ ] **Step 3: Gate reviews on product detail**

In `ProductDetailClient.tsx`, wrap the ReviewSection:

```tsx
import { useFeatures } from '../../../contexts/FeatureContext';
// ...
const { isEnabled } = useFeatures();
// ...
{isEnabled('reviews') && <ReviewSection ... />}
```

- [ ] **Step 4: Gate marketing pixels**

In `MarketingPixels.tsx`, add an early return:

```tsx
import { useFeatures } from '../contexts/FeatureContext';
// ...
const { isEnabled } = useFeatures();
if (!isEnabled('marketing_pixels')) return null;
```

- [ ] **Step 5: Gate account page links**

Read the account layout or sidebar. Conditionally render:

- Loyalty link: `{isEnabled('loyalty') && <Link ...>Loyalty</Link>}`
- Returns link: `{isEnabled('returns') && <Link ...>Returns</Link>}`

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/cart/CartClient.tsx \
  apps/web/src/app/products/[slug]/ProductDetailClient.tsx \
  apps/web/src/components/MarketingPixels.tsx \
  apps/web/src/components/Header.tsx \
  apps/web/src/app/account/
git commit -m "feat(web): gate storefront UI sections based on store feature flags"
```

---

## Task 14: Integration Test

**Files:**

- Create: `tests/e2e/feature-toggle.test.ts`

- [ ] **Step 1: Write integration test**

Follow the pattern in `tests/e2e/store.test.ts`. Test the full flow:

1. Create a store (setup)
2. Verify all features default to OFF
3. Enable `coupons` feature via `PUT /admin/stores/:id/features`
4. Verify `GET /admin/stores/:id/features` shows coupons enabled
5. Access coupon route → 200
6. Disable `coupons` feature
7. Access coupon route → 403 with `FEATURE_DISABLED` code
8. Verify public store endpoint includes `enabledFeatures`
9. Test Zod validation rejects unknown feature keys
10. Test idempotent single-feature set endpoint

- [ ] **Step 2: Run the test**

```bash
npx vitest run tests/e2e/feature-toggle.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/feature-toggle.test.ts
git commit -m "test(e2e): add integration tests for feature toggle engine"
```

---

## Task 15: Final Verification

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/ahmadsharaf/Desktop/projects/force-website-builder
npm run test
```

Expected: All existing tests pass + new tests pass.

- [ ] **Step 2: Run build**

```bash
npm run build
```

Expected: All workspaces build successfully.

- [ ] **Step 3: Manual smoke test**

1. Start API: `npm run dev:api`
2. Start Admin: `npm run dev:admin`
3. As super_admin: navigate to a store → Features tab → toggle some features ON/OFF → Save
4. As store_admin: verify disabled features are hidden from sidebar and settings
5. Start Web: `npm run dev:web` — verify disabled features are hidden from storefront

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete phase 0 feature toggle engine implementation"
```
