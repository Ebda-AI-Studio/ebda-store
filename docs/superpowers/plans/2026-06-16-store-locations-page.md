# Store Locations Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A platform-wide, per-store **Locations / Branches** feature — a bilingual (EN/AR), RTL-aware storefront `/locations` page that lists a store's physical branches (name, country, address, phone/WhatsApp, Google-Maps link + optional embed), plus an admin CRUD to manage them. Design follows the OSOSS reference layout; **all colors/fonts inherit the store's theme tokens** (zero hardcoded brand colors) so every store's page matches its own brand. Seeded with pecannbee's 8 branches.

**Architecture:** Mirror the existing **blog** vertical slice. New per-store `StoreLocation` Prisma model + hand-written migration with the standard tenant RLS policy (direct `store_id`) + FORCE RLS. `Store.locationsEnabled` column gates the feature (routes 404 when off — API-gated, default `false`). `LocationsService` + admin CRUD routes (`authenticate → authorize → requireStoreAccess → writeLimiter`) + a public list route gated by `locationsEnabled`. Admin page at `/stores/[id]/locations`. Storefront route `apps/web/src/app/locations/page.tsx` rendering country-grouped cards using theme tokens (`resolveColor` + `hsl(var(--…))`), `useLanguage().t()` for bilingual strings, and `isRtl` for direction. Default OFF platform-wide; enabled + seeded for pecannbee.

**Tech Stack:** Prisma (Neon Postgres + RLS), Express + TypeScript (apps/api), Next.js 16 App Router (apps/admin + apps/web), `@force/shared` (Zod + `resolveColor`), Vitest. Brand inheritance via `StoreTheme` tokens + globals.css CSS vars.

---

## Context the implementer needs (verified against the codebase)

**Mirror the blog feature** — the canonical recent per-store slice:

- Model: `BlogPost` (`packages/database/prisma/schema.prisma:459-480`) + `Store.blogEnabled` toggle.
- Migration: `packages/database/prisma/migrations/20260517130000_add_blog/migration.sql`; RLS added in a later `*_complete_force_rls_coverage`-style migration.
- API: `apps/api/src/routes/blog.routes.ts` — admin CRUD + public list, with a `gate<Feature>Enabled(storeId,res)` 404-guard at the top of every route. Service: `apps/api/src/services/blog.service.ts`.
- Admin: `apps/admin/src/app/stores/[id]/blog/page.tsx`; sidebar via `apps/admin/src/components/admin-layout/buildStoreAdminNav.ts`.
- Storefront: `apps/web/src/app/blog/page.tsx` + `[slug]/page.tsx`.

**Auth chain (every admin route):** `authenticate, authorize('store_admin','super_admin'), requireStoreAccess, writeLimiter` (writeLimiter on mutations only). Use `authorize()`, not `requireRole`.

**Gating decision:** use a **`Store.locationsEnabled` column** (not a theme flag) because the public + admin routes must 404 when off (API-gated), matching blog. Default `false` (new-visual-feature rule #2).

**RLS (REQUIRED for any new per-store table)** — direct `store_id` policy + FORCE, exact pattern:

```sql
ALTER TABLE "store_locations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rls_store_locations_tenant" ON "store_locations"
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );
ALTER TABLE "store_locations" FORCE ROW LEVEL SECURITY;
```

Without this, the storefront/admin reads return 0 rows under the tenant GUC (the same class of bug that bit the variant-import categories). Migrations apply on next API boot.

**Brand-token rule (the whole point — platform-wide inheritance):**

- Colors come from the theme, never hardcoded. On the storefront use Tailwind classes bound to globals.css CSS vars: `text-foreground`, `bg-card`, `border-border`, `text-primary`, `bg-primary`, `text-muted-foreground`, `bg-background`. For any merchant-saved `token:*` value use `resolveColor(value, theme)` from `@force/shared`, which MUST fall back to `hsl(var(--<key>))` (UI rule #15).
- Use Tailwind size classes (`text-sm`, `text-lg`…), NEVER arbitrary `text-[Npx]` (UI rule #7).
- Fonts inherit automatically from the store's theme (`var(--font-arabic)` / `var(--font-sans)` are already wired by StoreContext).
- RTL: wrap with `dir={isRtl ? 'rtl' : 'ltr'}`; bilingual strings via `const { t, isRtl } = useLanguage(); t('Locations','الفروع')`.

**i18n:** add EN→AR pairs to `apps/web/src/contexts/LanguageContext.tsx` `translations` map.

**Captured seed data:** `~/Downloads/pecannbee-migration/locations-page/locations.json` (8 branches, EN+AR-ready, phones, maps links, social). Pecannbee store id: `359afc1f-ea5b-4f8d-b372-c038c6c057f7`.

**Pre-req:** worktree `/Users/ahmadsharaf/Desktop/projects/_worktrees/force-website-builder__feat-ososs-variant-import`, branch `feat/store-locations-page` (off origin/main). Run `npm run db:generate` before typecheck. Local test DB: create `fwb_loc_test` on localhost + `prisma db push`; run integration with `DATABASE_URL` set to it (db push applies NO RLS, so test inserts need no tenant context — same as the variant-import tests).

---

## File Structure

| File                                                                                   | Responsibility                                                         | Action |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| `packages/database/prisma/schema.prisma`                                               | Add `StoreLocation` model + `Store.locationsEnabled` + relation.       | Modify |
| `packages/database/prisma/migrations/20260616120000_add_store_locations/migration.sql` | Table + indexes + RLS policy + FORCE + `stores.locations_enabled`.     | Create |
| `packages/shared/src/schemas/location.ts`                                              | Zod schema for a location row (create/update) + maps-URL validation.   | Create |
| `apps/api/src/services/locations.service.ts`                                           | `list/listPublished/create/update/remove/reorder`.                     | Create |
| `apps/api/src/routes/locations.routes.ts`                                              | Admin CRUD + public list, `gateLocationsEnabled` guard.                | Create |
| `apps/api/src/routes/index.ts` (or where blog routes mount)                            | Mount the locations router.                                            | Modify |
| `apps/admin/src/app/stores/[id]/locations/page.tsx`                                    | Admin list + create/edit/delete + enable toggle.                       | Create |
| `apps/admin/src/components/admin-layout/buildStoreAdminNav.ts`                         | Add "Locations" under the Settings hub.                                | Modify |
| `apps/web/src/app/locations/page.tsx`                                                  | Storefront route (server wrapper).                                     | Create |
| `apps/web/src/app/locations/LocationsClient.tsx`                                       | Client component: country-grouped, token-styled, RTL, bilingual cards. | Create |
| `apps/web/src/contexts/LanguageContext.tsx`                                            | Add Locations EN→AR strings.                                           | Modify |
| `tests/unit/location-schema.test.ts`                                                   | Zod + maps-URL validation/normalisation.                               | Create |
| `tests/integration/store-locations.test.ts`                                            | CRUD + gating + ordering against real DB.                              | Create |
| `packages/database/scripts/seed-pecannbee-locations.ts`                                | One-off seed of pecannbee's 8 branches + enable toggle.                | Create |
| `docs/runbooks/store-locations.md`                                                     | Feature doc (model, gating, admin, storefront, seed).                  | Create |

---

## Data model (locked — used across tasks)

```prisma
model StoreLocation {
  id           String   @id @default(uuid())
  storeId      String   @map("store_id")
  name         String
  nameAr       String?  @map("name_ar")
  country      String                       // e.g. "Kuwait" | "U.A.E."
  countryAr    String?  @map("country_ar")
  address      String
  addressAr    String?  @map("address_ar")
  phone        String?                      // tel: target, e.g. "+96522209079"
  whatsapp     String?                      // wa.me number, digits only or +<intl>
  mapsUrl      String?  @map("maps_url")    // Google Maps "search" link (button target)
  mapsEmbedUrl String?  @map("maps_embed_url") // optional ...&output=embed iframe src
  hours        String?
  hoursAr      String?  @map("hours_ar")
  isPublished  Boolean  @default(true) @map("is_published")
  position     Int      @default(0)
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId, isPublished, position])
  @@map("store_locations")
}
```

Plus on `Store`: `locationsEnabled Boolean @default(false) @map("locations_enabled")` and `locations StoreLocation[]`.

---

### Task 1: Schema + migration (with RLS)

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260616120000_add_store_locations/migration.sql`

- [ ] **Step 1: Add the model + Store fields to schema.prisma**

Add the `StoreLocation` model (above) near `BlogPost`. On the `Store` model add:

```prisma
  locationsEnabled Boolean @default(false) @map("locations_enabled")
  locations        StoreLocation[]
```

- [ ] **Step 2: Write the migration SQL**

```sql
-- Per-store physical locations / branches feature.
ALTER TABLE "stores" ADD COLUMN "locations_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "store_locations" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "store_id"       TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "name_ar"        TEXT,
    "country"        TEXT NOT NULL,
    "country_ar"     TEXT,
    "address"        TEXT NOT NULL,
    "address_ar"     TEXT,
    "phone"          TEXT,
    "whatsapp"       TEXT,
    "maps_url"       TEXT,
    "maps_embed_url" TEXT,
    "hours"          TEXT,
    "hours_ar"       TEXT,
    "is_published"   BOOLEAN NOT NULL DEFAULT true,
    "position"       INTEGER NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "store_locations_store_id_fkey"
        FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE
);
CREATE INDEX "store_locations_store_id_is_published_position_idx"
    ON "store_locations"("store_id", "is_published", "position");

ALTER TABLE "store_locations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rls_store_locations_tenant" ON "store_locations"
  FOR ALL TO force_app
  USING (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  )
  WITH CHECK (
    current_store_id() IS NULL
    OR current_setting('app.bypass_rls', true) = 'true'
    OR store_id::text = current_store_id()
  );
ALTER TABLE "store_locations" FORCE ROW LEVEL SECURITY;
```

- [ ] **Step 3: Generate client + verify it applies to a local test DB**

```bash
cd <worktree>
createdb -h localhost fwb_loc_test 2>/dev/null || true
npm run db:generate
DATABASE_URL=postgresql://$USER@localhost:5432/fwb_loc_test DIRECT_URL=postgresql://$USER@localhost:5432/fwb_loc_test \
  npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
psql -h localhost -d fwb_loc_test -c "\d store_locations" | head -20
```

Expected: table exists; `prisma generate` reports `StoreLocation`. (Note: `force_app` role may not exist locally — if `migrate deploy` errors on `TO force_app`, use `npx prisma db push` for the local test DB instead, which skips the RLS SQL; RLS is validated in CI/prod where `force_app` exists.)

- [ ] **Step 4: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260616120000_add_store_locations
git commit -m "feat(database): add StoreLocation model + locationsEnabled toggle + RLS"
```

---

### Task 2: Shared Zod schema + maps-URL helper (unit-tested)

**Files:**

- Create: `packages/shared/src/schemas/location.ts` (export from the package index)
- Test: `tests/unit/location-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/location-schema.test.ts
import { describe, it, expect } from 'vitest';
import { locationInputSchema, mapsSearchUrl } from '../../packages/shared/src/schemas/location';

describe('locationInputSchema', () => {
  it('accepts a minimal valid location', () => {
    const r = locationInputSchema.safeParse({
      name: 'Avenues',
      country: 'Kuwait',
      address: 'Al-Rai',
    });
    expect(r.success).toBe(true);
  });
  it('requires name, country, address', () => {
    expect(
      locationInputSchema.safeParse({ name: '', country: 'Kuwait', address: 'x' }).success
    ).toBe(false);
    expect(locationInputSchema.safeParse({ name: 'A', country: '', address: 'x' }).success).toBe(
      false
    );
  });
  it('rejects a non-http maps url (anti-XSS)', () => {
    expect(
      locationInputSchema.safeParse({
        name: 'A',
        country: 'K',
        address: 'x',
        mapsUrl: 'javascript:alert(1)',
      }).success
    ).toBe(false);
  });
  it('accepts https maps urls', () => {
    expect(
      locationInputSchema.safeParse({
        name: 'A',
        country: 'K',
        address: 'x',
        mapsUrl: 'https://www.google.com/maps/search/?api=1&query=X',
      }).success
    ).toBe(true);
  });
});

describe('mapsSearchUrl', () => {
  it('builds a google maps search url from a query', () => {
    expect(mapsSearchUrl('Avenues Mall Kuwait')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Avenues%20Mall%20Kuwait'
    );
  });
});
```

- [ ] **Step 2: Run → fail**
      Run: `cd <worktree> && npx vitest run tests/unit/location-schema.test.ts`
      Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
// packages/shared/src/schemas/location.ts
import { z } from 'zod';

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine(u => /^https?:\/\//i.test(u), 'URL must be http(s)')
  .optional()
  .or(z.literal('').transform(() => undefined));

export const locationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  nameAr: z.string().trim().max(200).optional(),
  country: z.string().trim().min(1).max(100),
  countryAr: z.string().trim().max(100).optional(),
  address: z.string().trim().min(1).max(500),
  addressAr: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(40).optional(),
  whatsapp: z.string().trim().max(40).optional(),
  mapsUrl: httpsUrl,
  mapsEmbedUrl: httpsUrl,
  hours: z.string().trim().max(200).optional(),
  hoursAr: z.string().trim().max(200).optional(),
  isPublished: z.boolean().optional().default(true),
  position: z.number().int().min(0).max(10_000).optional().default(0),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export function mapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
```

Then re-export from `packages/shared/src/index.ts` (add `export * from './schemas/location';`).

- [ ] **Step 4: Run → pass**
      Run: `npx vitest run tests/unit/location-schema.test.ts` → PASS (5).

- [ ] **Step 5: Build shared + commit**

```bash
npm run build -w packages/shared
git add packages/shared/src/schemas/location.ts packages/shared/src/index.ts tests/unit/location-schema.test.ts
git commit -m "feat(shared): location Zod schema + maps url helper"
```

---

### Task 3: LocationsService

**Files:**

- Create: `apps/api/src/services/locations.service.ts`

- [ ] **Step 1: Implement the service** (uses the tenant-routed `prisma`; reads/writes happen under `runInTenantContext` set by the route middleware)

```typescript
import { prisma, Prisma } from '@force/database';
import type { LocationInput } from '@force/shared';

export class LocationsService {
  static list(storeId: string) {
    return prisma.storeLocation.findMany({
      where: { storeId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }
  static listPublished(storeId: string) {
    return prisma.storeLocation.findMany({
      where: { storeId, isPublished: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }
  static create(storeId: string, data: LocationInput) {
    return prisma.storeLocation.create({ data: { ...data, storeId } });
  }
  static async update(storeId: string, id: string, data: Partial<LocationInput>) {
    // store-scope the update so a tenant can't touch another store's row by id
    const res = await prisma.storeLocation.updateMany({ where: { id, storeId }, data });
    if (res.count === 0) return null;
    return prisma.storeLocation.findUnique({ where: { id } });
  }
  static async remove(storeId: string, id: string) {
    const res = await prisma.storeLocation.deleteMany({ where: { id, storeId } });
    return res.count > 0;
  }
}
```

- [ ] **Step 2: Typecheck**
      Run: `cd <worktree> && npm run db:generate && npx tsc --noEmit -p apps/api/tsconfig.json`
      Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/locations.service.ts
git commit -m "feat(api): LocationsService (store-scoped CRUD)"
```

---

### Task 4: API routes (admin CRUD + public list, gated)

**Files:**

- Create: `apps/api/src/routes/locations.routes.ts`
- Modify: wherever blog routes are registered (e.g. `apps/api/src/routes/index.ts` or `apps/api/src/index.ts`) — mount the router the same way.

- [ ] **Step 1: Implement the routes** (mirror `blog.routes.ts`)

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '@force/database';
import { authenticate, authorize, requireStoreAccess } from '../middleware/auth';
import { writeLimiter } from '../middleware/security';
import { LocationsService } from '../services/locations.service';
import { locationInputSchema } from '@force/shared';

const router = Router();

async function gateLocationsEnabled(storeId: string, res: Response): Promise<boolean> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { locationsEnabled: true },
  });
  if (!store?.locationsEnabled) {
    res.status(404).json({
      success: false,
      error: { code: 'LOCATIONS_DISABLED', message: 'Locations not enabled for this store' },
    });
    return true;
  }
  return false;
}

// ---- Admin ----
router.get(
  '/stores/:storeId/locations',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      res.json({
        success: true,
        data: { locations: await LocationsService.list(req.params.storeId) },
      });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/stores/:storeId/locations',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req, res, next) => {
    try {
      const data = locationInputSchema.parse(req.body);
      res.status(201).json({
        success: true,
        data: { location: await LocationsService.create(req.params.storeId, data) },
      });
    } catch (e) {
      next(e);
    }
  }
);

router.put(
  '/stores/:storeId/locations/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req, res, next) => {
    try {
      const data = locationInputSchema.partial().parse(req.body);
      const loc = await LocationsService.update(req.params.storeId, req.params.id, data);
      if (!loc) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Location not found' } });
        return;
      }
      res.json({ success: true, data: { location: loc } });
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  '/stores/:storeId/locations/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req, res, next) => {
    try {
      const ok = await LocationsService.remove(req.params.storeId, req.params.id);
      res.status(ok ? 200 : 404).json({
        success: ok,
        ...(ok ? {} : { error: { code: 'NOT_FOUND', message: 'Location not found' } }),
      });
    } catch (e) {
      next(e);
    }
  }
);

// ---- Public ----
router.get('/public/:storeId/locations', async (req, res, next) => {
  try {
    if (await gateLocationsEnabled(req.params.storeId, res)) return;
    res.json({
      success: true,
      data: { locations: await LocationsService.listPublished(req.params.storeId) },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
```

(Confirm the exact `authenticate`/`authorize`/`requireStoreAccess` import path from `blog.routes.ts` — match it verbatim. Mount with the same prefix the blog router uses so paths resolve to `/api/v1/...`.)

- [ ] **Step 2: Register the router** next to the blog router registration, e.g. `app.use('/api/v1', locationsRoutes)` or the aggregator's `router.use(locationsRoutes)` — match blog exactly.

- [ ] **Step 3: Typecheck**
      Run: `npx tsc --noEmit -p apps/api/tsconfig.json` → clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/locations.routes.ts apps/api/src/routes/index.ts
git commit -m "feat(api): locations admin CRUD + public list routes (gated)"
```

---

### Task 5: Integration test (real DB, CRUD + gating + isolation)

**Files:**

- Create: `tests/integration/store-locations.test.ts`

Mirror `tests/integration/bulk-variant-import.test.ts` (non-destructive: own user+store, cleanup by storeId; prod guard lives in `tests/setup-e2e.ts`).

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { LocationsService } from '../../apps/api/src/services/locations.service';

const S = `loc-${Date.now()}`;
let userId: string, storeId: string;

beforeAll(async () => {
  const u = await prisma.user.create({
    data: {
      email: `${S}@test.local`,
      passwordHash: 'x',
      firstName: 'L',
      lastName: 'T',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  userId = u.id;
  const s = await prisma.store.create({
    data: {
      name: 'Loc Test',
      slug: `store-${S}`,
      ownerId: userId,
      plan: 'enterprise',
      status: 'active',
      locationsEnabled: true,
    },
  });
  storeId = s.id;
});
afterAll(async () => {
  await prisma.storeLocation.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('LocationsService', () => {
  it('creates, lists ordered, updates store-scoped, filters published, deletes', async () => {
    const a = await LocationsService.create(storeId, {
      name: 'Avenues F-152',
      country: 'Kuwait',
      address: 'Al-Rai',
      position: 1,
      isPublished: true,
    } as any);
    const b = await LocationsService.create(storeId, {
      name: 'Hidden',
      country: 'Kuwait',
      address: 'x',
      position: 0,
      isPublished: false,
    } as any);
    const all = await LocationsService.list(storeId);
    expect(all.map(l => l.name)).toEqual(['Hidden', 'Avenues F-152']); // by position asc
    const pub = await LocationsService.listPublished(storeId);
    expect(pub.map(l => l.name)).toEqual(['Avenues F-152']);
    const upd = await LocationsService.update(storeId, a.id, { address: 'Al-Rai, Ghazali St' });
    expect(upd?.address).toBe('Al-Rai, Ghazali St');
    expect(
      await LocationsService.update('00000000-0000-0000-0000-000000000000', a.id, {
        address: 'hack',
      })
    ).toBeNull(); // cross-store blocked
    expect(await LocationsService.remove(storeId, b.id)).toBe(true);
    expect((await LocationsService.list(storeId)).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run against local test DB**

```bash
DATABASE_URL=postgresql://$USER@localhost:5432/fwb_loc_test TEST_DATABASE_URL=postgresql://$USER@localhost:5432/fwb_loc_test DIRECT_URL=postgresql://$USER@localhost:5432/fwb_loc_test \
  npx vitest run tests/integration/store-locations.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/store-locations.test.ts
git commit -m "test(api): integration coverage for store locations CRUD"
```

---

### Task 6: i18n strings

**Files:**

- Modify: `apps/web/src/contexts/LanguageContext.tsx`

- [ ] **Step 1: Add EN→AR pairs to the `translations` map**

```typescript
  'Locations': 'الفروع',
  'Our Locations': 'فروعنا',
  'Visit a store — tap a branch for directions, to call, or to message us.': 'زر أحد فروعنا — اضغط على الفرع للاتجاهات أو الاتصال أو المراسلة.',
  'Open in Maps': 'افتح في الخرائط',
  'Call': 'اتصال',
  'WhatsApp': 'واتساب',
  'Address': 'العنوان',
  'Hours': 'ساعات العمل',
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/contexts/LanguageContext.tsx
git commit -m "feat(web): locations i18n strings (en/ar)"
```

---

### Task 7: Storefront `/locations` page (token-driven, RTL, bilingual)

**Files:**

- Create: `apps/web/src/app/locations/page.tsx`
- Create: `apps/web/src/app/locations/LocationsClient.tsx`

- [ ] **Step 1: Server wrapper** (mirror `apps/web/src/app/blog/page.tsx` — resolve store + fetch public list; if `locationsEnabled` off the API 404s → render notFound())

```tsx
// apps/web/src/app/locations/page.tsx
import { notFound } from 'next/navigation';
import { getStoreFromHeaders, apiGet } from '@/lib/server-api'; // match blog's helper imports
import LocationsClient from './LocationsClient';

export const dynamic = 'force-dynamic';

export default async function LocationsPage() {
  const store = await getStoreFromHeaders();
  if (!store) notFound();
  const res = await apiGet<{ locations: any[] }>(`/public/${store.id}/locations`).catch(() => null);
  if (!res) notFound(); // 404 when feature disabled
  return <LocationsClient locations={res.locations} />;
}
```

(Use the EXACT store-resolution + fetch helpers `blog/page.tsx` uses — copy its imports/pattern.)

- [ ] **Step 2: Client component — country-grouped, theme-token styled**

```tsx
// apps/web/src/app/locations/LocationsClient.tsx
'use client';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStore } from '@/contexts/StoreContext';

type Loc = {
  id: string;
  name: string;
  nameAr?: string;
  country: string;
  countryAr?: string;
  address: string;
  addressAr?: string;
  phone?: string;
  whatsapp?: string;
  mapsUrl?: string;
  mapsEmbedUrl?: string;
  hours?: string;
  hoursAr?: string;
};

export default function LocationsClient({ locations }: { locations: Loc[] }) {
  const { t, isRtl } = useLanguage();
  // group by country, preserving first-seen order
  const groups: { country: string; countryAr?: string; items: Loc[] }[] = [];
  for (const l of locations) {
    let g = groups.find(g => g.country === l.country);
    if (!g) {
      g = { country: l.country, countryAr: l.countryAr, items: [] };
      groups.push(g);
    }
    g.items.push(l);
  }
  const tx = (en?: string, ar?: string) => (isRtl ? ar || en : en) || '';

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="bg-background text-foreground min-h-screen">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:py-14">
        <header className="text-center mb-10">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">
            {t('Locations', 'الفروع')}
          </h1>
          <div className="mx-auto mt-3 h-0.5 w-16 bg-primary rounded-full" />
          <p className="mt-4 text-sm sm:text-base text-muted-foreground max-w-xl mx-auto">
            {t(
              'Visit a store — tap a branch for directions, to call, or to message us.',
              'زر أحد فروعنا — اضغط على الفرع للاتجاهات أو الاتصال أو المراسلة.'
            )}
          </p>
        </header>

        {groups.map(g => (
          <section key={g.country} className="mb-10">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-primary mb-4">
              {tx(g.country, g.countryAr)}
            </h2>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {g.items.map(l => (
                <article
                  key={l.id}
                  className="rounded-2xl border border-border bg-card p-4 shadow-sm flex flex-col"
                >
                  {l.mapsEmbedUrl && (
                    <iframe
                      src={l.mapsEmbedUrl}
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                      className="w-full h-36 rounded-xl border border-border mb-3"
                      title={tx(l.name, l.nameAr)}
                    />
                  )}
                  <h3 className="text-base font-semibold text-foreground">
                    {tx(l.name, l.nameAr)}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground flex-1">
                    {tx(l.address, l.addressAr)}
                  </p>
                  {l.hours && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('Hours', 'ساعات العمل')}: {tx(l.hours, l.hoursAr)}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {l.mapsUrl && (
                      <a
                        href={l.mapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                      >
                        📍 {t('Open in Maps', 'افتح في الخرائط')}
                      </a>
                    )}
                    {l.phone && (
                      <a
                        href={`tel:${l.phone}`}
                        className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground"
                      >
                        {t('Call', 'اتصال')}
                      </a>
                    )}
                    {l.whatsapp && (
                      <a
                        href={`https://wa.me/${l.whatsapp.replace(/[^0-9]/g, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground"
                      >
                        {t('WhatsApp', 'واتساب')}
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
```

Notes: every color is a globals.css token (`bg-background/card/primary`, `text-foreground/muted-foreground/primary-foreground`, `border-border`) → inherits each store's brand automatically; no hardcoded hex. Sizes are Tailwind classes (rule #7). `href` values are http(s)/tel/wa.me only (XSS-safe; the API already validated `mapsUrl`).

- [ ] **Step 3: Verify by rendering (per the verify-by-rendering rule)**
      Run dev web (`npm run dev:web`), enable `locationsEnabled` + seed (Task 9) on a local store, open `/locations` in both EN and AR (toggle language) and confirm: cards render, colors match the store theme, RTL flips layout, map/call/whatsapp links work. Screenshot.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/locations
git commit -m "feat(web): storefront locations page (token-driven, rtl, bilingual)"
```

---

### Task 8: Admin CRUD page + sidebar link

**Files:**

- Create: `apps/admin/src/app/stores/[id]/locations/page.tsx`
- Modify: `apps/admin/src/components/admin-layout/buildStoreAdminNav.ts`

- [ ] **Step 1: Build the admin page** (mirror `apps/admin/src/app/stores/[id]/blog/page.tsx`): a list table (name, country, published chip, position), a create/edit form (all fields incl. nameAr/addressAr/phone/whatsapp/mapsUrl/mapsEmbedUrl/hours/published/position), delete action, and an **"Enable Locations" toggle** that PUTs `store.locationsEnabled` (reuse the existing store-update endpoint the blog toggle uses). Use `apiGet/apiPost/apiPut/apiDelete` from `lib/api.ts`. Wrap in `<AdminLayout>`.

- [ ] **Step 2: Add sidebar entry** under the Settings hub in `buildStoreAdminNav.ts` (mirror how blog/dividers are added): a nav item label `Locations` → `/stores/${storeId}/locations`. Add the label to the `NavLabels` type if required.

- [ ] **Step 3: Typecheck admin**
      Run: `npx tsc --noEmit -p apps/admin/tsconfig.json` → clean.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/app/stores/[id]/locations apps/admin/src/components/admin-layout/buildStoreAdminNav.ts
git commit -m "feat(admin): locations CRUD page + sidebar entry"
```

---

### Task 9: Seed pecannbee's 8 branches + enable

**Files:**

- Create: `packages/database/scripts/seed-pecannbee-locations.ts`

- [ ] **Step 1: Write the seed** (reads the captured `locations.json`; idempotent upsert by `[storeId,name]`; sets `locationsEnabled=true`). Uses `withRlsBypass` or runs as `neondb_owner` (cross-tenant seed).

```typescript
import { prisma } from '@force/database';
import fs from 'fs';
import os from 'os';
import path from 'path';

const STORE_ID = '359afc1f-ea5b-4f8d-b372-c038c6c057f7';
const data = JSON.parse(
  fs.readFileSync(
    path.join(os.homedir(), 'Downloads/pecannbee-migration/locations-page/locations.json'),
    'utf8'
  )
);

async function main() {
  await prisma.store.update({ where: { id: STORE_ID }, data: { locationsEnabled: true } });
  for (let i = 0; i < data.locations.length; i++) {
    const l = data.locations[i];
    const existing = await prisma.storeLocation.findFirst({
      where: { storeId: STORE_ID, name: l.name },
    });
    const payload = {
      storeId: STORE_ID,
      name: l.name,
      country: l.country,
      address: l.address,
      mapsUrl: l.mapsSearch,
      mapsEmbedUrl: l.mapsEmbed,
      position: i,
      isPublished: true,
      phone: data.contacts?.phones?.general,
      whatsapp: data.contacts?.phones?.general,
    };
    if (existing) await prisma.storeLocation.update({ where: { id: existing.id }, data: payload });
    else await prisma.storeLocation.create({ data: payload });
  }
  console.log('seeded', data.locations.length, 'locations');
}
main().finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Run it (against prod, post-deploy)** — `npx tsx packages/database/scripts/seed-pecannbee-locations.ts` with the prod `DATABASE_URL`, OR (preferred) create the 8 via the admin UI / the public-safe path once deployed. Verify on the storefront `/locations`.

- [ ] **Step 3: Commit**

```bash
git add packages/database/scripts/seed-pecannbee-locations.ts
git commit -m "chore(database): pecannbee locations seed script"
```

---

### Task 10: Docs + full gate pass

**Files:**

- Create: `docs/runbooks/store-locations.md`

- [ ] **Step 1: Write the runbook** — model, gating (`locationsEnabled`), admin path, storefront route, token-inheritance note, seed instructions, and how merchants add a footer/nav link to `/locations` (via `store.settings.footerLinks`).
- [ ] **Step 2: Gates**

```bash
cd <worktree>
npm run db:generate && npm run lint && npm run typecheck
npx vitest run tests/unit/location-schema.test.ts tests/integration/store-locations.test.ts
npx prettier --write $(git diff --name-only origin/main..HEAD | grep -E '\.(ts|tsx|json|md)$' | tr '\n' ' ')
npm audit --audit-level=low --omit=dev
```

Expected: all green; audit 0 prod vulns.

- [ ] **Step 3: Commit** any formatting, then open PR to `main`.

---

## Self-Review

- **Spec coverage:** structured per-store model (T1) ✓; bilingual/RTL storefront (T6,T7) ✓; token-driven brand inheritance (T7 — every color a globals.css token) ✓; admin CRUD + toggle + nav (T8) ✓; gating default-off (T1,T4) ✓; RLS (T1) ✓; maps link + optional embed + call + whatsapp (T2,T7) ✓; pecannbee seed of the 8 captured branches (T9) ✓; tests unit+integration (T2,T5) ✓; docs (T10) ✓.
- **Placeholder scan:** all steps carry real code; no TBD.
- **Type consistency:** `locationInputSchema`/`LocationInput`, `LocationsService.{list,listPublished,create,update,remove}`, `StoreLocation` fields, `locationsEnabled` used consistently T1→T9.
- **Execution-time confirmations (not blockers):** exact import path of `authenticate/authorize/requireStoreAccess` + router registration (copy from `blog.routes.ts`); the server-side store-resolution helper names in `apps/web` (copy from `blog/page.tsx`); whether the local `force_app` role exists (else `db push` for the local test DB). `primary-foreground`/`muted-foreground` tokens exist in globals.css (verify; fall back to `text-white`/`text-foreground/70` if not).

## Design reference & notes

- **Canonical design = the Stitch output**, committed at `docs/superpowers/design/locations/`: `DESIGN.md` (design system), `stitch-base.{html,png}` (variant WITH Call + WhatsApp pills — **use this one**), `stitch-luxury.{html,png}` (cleaner variant). It realises the OSOSS layout Ahmad approved (`~/Downloads/pecannbee-migration/locations-page/`). Stitch project: `7921301776419675918`.
- **Card structure to match (from `stitch-base.html`):** card = rounded-2xl (16px) + hairline border + soft "card-hover" lift; a map view image on top (`h-48`, `grayscale opacity-70 hover:grayscale-0 transition-all duration-700`); body with `headline-sm` branch name + muted address + a `flex flex-wrap gap-2` row of pills — filled "Open in Maps" (pin icon) + outline "Call" + outline "WhatsApp". Country section = a small uppercase chip ("KUWAIT 🇰🇼") followed by a `flex-grow h-px` hairline divider, then `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6`. Generous section spacing (~64px), centered `max-w` container, RTL-mirrored.
- **Token mapping (Stitch Material tokens → FWB globals.css theme tokens) — this is what makes it brand-inheriting & platform-wide:**
  | Stitch | FWB |
  |---|---|
  | `bg-surface` / `background` | `bg-background` |
  | `bg-surface-container-lowest` (cards) | `bg-card` |
  | `text-on-surface` | `text-foreground` |
  | `text-on-surface-variant` | `text-muted-foreground` |
  | `bg-primary` / `text-on-primary` | `bg-primary` / `text-primary-foreground` |
  | `text-primary` / headline `text-[#5B3928]` | `text-primary` (NOT the hex) |
  | `border-outline-variant` / `border-outline` | `border-border` |
  | country chip `bg-secondary-container` | `bg-primary/10 text-primary` (or `accent` token) |
  | shadows `rgba(33,37,41,.04/.08)` | keep as-is (neutral, not brand) |
  Apply the Stitch **structure, spacing, 16px radius, grayscale-map-hover, soft-lift** as fixed design; take **all colors + fonts from the theme**. The DESIGN.md's IBM Plex Sans is the pecannbee feel — but the component inherits the store's theme font, so each store keeps its own typeface.
- Icons: Stitch uses Material Symbols (not loaded in FWB) — replace with inline SVGs (or the existing FWB icon set / simple glyphs). Do NOT add a Material Symbols dependency.
- Map view: use the location's `mapsEmbedUrl` in a lazy `<iframe>` styled with the grayscale-hover treatment; if absent, render a tappable map-pin placeholder card linking to `mapsUrl`.
- **Brand inheritance is the core requirement:** the storefront component hardcodes ZERO colors — it paints entirely from the store's theme tokens, so the same page renders pecan-brown for pecannbee and each other store's palette for them. Platform-wide, default-off (enabled per store; pecannbee enabled in T9).
