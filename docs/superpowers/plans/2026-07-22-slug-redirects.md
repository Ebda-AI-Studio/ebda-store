# Slug Redirects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Product/Category/Page/Blog slug changes, the old storefront URL 301/308-redirects to the new URL instead of 404ing.

**Architecture:** One generic per-store `SlugRedirect` table. A shared `recordSlugRedirect` helper (chain-collapse + reuse-guard) is called inside each slug-change chokepoint in the same transaction as the entity write. A `resolveSlugRedirect` helper + public endpoint is called by each storefront route only on a lookup miss, emitting `permanentRedirect` (308) on hit and `notFound()` (real 404) on miss — the latter also fixes the existing soft-404.

**Tech Stack:** Prisma + Neon Postgres; Express+TS API (`apps/api`); Next.js 16 App Router web (`apps/web`); Zod (`@ebda/shared`); Jest.

## Global Constraints

- Platform-level, `storeId`-scoped only. Never branch on `store.slug`. Never per-tenant code.
- Write helper runs inside the entity write's Prisma transaction (RLS tenant context already set on that path).
- commitlint: all-lowercase subject; blank line before `Co-Authored-By`.
- Redis TTL floor 120s — N/A here (no new caches).
- New visual features default OFF — N/A (no UI toggle; this is always-on infra).
- Every commit: `git add` explicit paths, never `-A`.
- Migrations live in `packages/database/prisma/migrations`; run `npm run db:generate` after schema edits.
- Path prefixes for redirect targets: product `/products/<slug>`, category/page/blog — confirm each route's real base path from the route file before wiring (do not assume).

---

### Task 1: `SlugRedirect` model + migration

**Files:**

- Modify: `packages/database/prisma/schema.prisma` (add enum + model; add relation field on `Store`)
- Create: migration under `packages/database/prisma/migrations/<timestamp>_add_slug_redirect/migration.sql` (generated)

**Interfaces:**

- Produces: Prisma model `SlugRedirect { id, storeId, entityType: SlugEntityType, fromSlug, toSlug, createdAt, updatedAt }`; enum `SlugEntityType { PRODUCT CATEGORY PAGE BLOG }`; `Store.slugRedirects SlugRedirect[]`.

- [ ] **Step 1: Add enum + model to schema**

In `packages/database/prisma/schema.prisma`, add:

```prisma
enum SlugEntityType {
  PRODUCT
  CATEGORY
  PAGE
  BLOG
}

model SlugRedirect {
  id         String         @id @default(cuid())
  storeId    String
  entityType SlugEntityType
  fromSlug   String
  toSlug     String
  createdAt  DateTime       @default(now())
  updatedAt  DateTime       @updatedAt

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, entityType, fromSlug])
  @@index([storeId, entityType, toSlug])
}
```

And add the back-relation on the `Store` model (find the `model Store {` block, add alongside its other relations):

```prisma
  slugRedirects SlugRedirect[]
```

- [ ] **Step 2: Generate the migration**

Run: `cd packages/database && npx prisma migrate dev --name add_slug_redirect --create-only`
Expected: a new `migration.sql` creating the enum, table, unique index, and secondary index. Inspect it — confirm `ON DELETE CASCADE` on the `storeId` FK.

- [ ] **Step 3: Apply + generate client**

Run: `npm run db:migrate && npm run db:generate` (from repo root)
Expected: migration applies clean; Prisma client regenerates with `SlugRedirect` + `SlugEntityType`.

- [ ] **Step 4: Blast-radius — cascade check**

Run:

```bash
psql "$DIRECT_URL" -c "select tc.constraint_name, rc.delete_rule from information_schema.referential_constraints rc join information_schema.table_constraints tc on tc.constraint_name=rc.constraint_name where tc.table_name='SlugRedirect';"
```

Expected: the `storeId` FK shows `CASCADE`. Record the result.

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations
git commit -m "feat(db): add SlugRedirect table for renamed-handle 301s"
```

---

### Task 2: `recordSlugRedirect` capture helper (unit-tested)

**Files:**

- Create: `apps/api/src/services/slug-redirect.service.ts`
- Test: `apps/api/src/services/__tests__/slug-redirect.service.test.ts` (match the repo's existing service-test location/pattern — confirm before writing)

**Interfaces:**

- Consumes: Prisma `SlugEntityType` (Task 1); a Prisma transaction client `tx: Prisma.TransactionClient`.
- Produces:
  - `recordSlugRedirect(tx, storeId: string, entityType: SlugEntityType, oldSlug: string, newSlug: string): Promise<void>`
  - `resolveSlugRedirect(storeId: string, entityType: SlugEntityType, slug: string): Promise<string | null>` (Task 3 fills this in; declare the stub here so both live in one file)

- [ ] **Step 1: Write failing unit tests**

```ts
import { PrismaClient, SlugEntityType } from '@ebda/database';
import { recordSlugRedirect } from '../slug-redirect.service';

// Uses the integration test DB per repo convention; adapt the harness import
// to match sibling service tests (e.g. getTestPrisma / truncate helpers).
const prisma = new PrismaClient();
const STORE = 'store_test_slug';

async function seedStore() {
  /* create store STORE via existing test factory */
}
async function clear() {
  await prisma.slugRedirect.deleteMany({ where: { storeId: STORE } });
}

beforeAll(seedStore);
beforeEach(clear);
afterAll(() => prisma.$disconnect());

test('no-op when slug unchanged', async () => {
  await prisma.$transaction(tx => recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'a', 'a'));
  expect(await prisma.slugRedirect.count({ where: { storeId: STORE } })).toBe(0);
});

test('records old -> new on change', async () => {
  await prisma.$transaction(tx =>
    recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'old', 'new')
  );
  const row = await prisma.slugRedirect.findFirst({
    where: { storeId: STORE, entityType: SlugEntityType.PRODUCT, fromSlug: 'old' },
  });
  expect(row?.toSlug).toBe('new');
});

test('reuse guard: recording X->Y deletes any existing fromSlug=Y', async () => {
  await prisma.$transaction(tx => recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'y', 'z')); // y->z exists
  await prisma.$transaction(tx => recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'x', 'y')); // y now live again
  expect(
    await prisma.slugRedirect.findFirst({ where: { storeId: STORE, fromSlug: 'y' } })
  ).toBeNull();
  expect(
    (await prisma.slugRedirect.findFirst({ where: { storeId: STORE, fromSlug: 'x' } }))?.toSlug
  ).toBe('y');
});

test('chain-collapse: A->B then B->C rewrites A->C', async () => {
  await prisma.$transaction(tx => recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'a', 'b'));
  await prisma.$transaction(tx => recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'b', 'c'));
  expect(
    (await prisma.slugRedirect.findFirst({ where: { storeId: STORE, fromSlug: 'a' } }))?.toSlug
  ).toBe('c');
  expect(
    (await prisma.slugRedirect.findFirst({ where: { storeId: STORE, fromSlug: 'b' } }))?.toSlug
  ).toBe('c');
});

test('upsert overwrites an existing fromSlug target', async () => {
  await prisma.$transaction(tx =>
    recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'old', 'new1')
  );
  await prisma.$transaction(tx =>
    recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'old', 'new2')
  );
  expect(
    (await prisma.slugRedirect.findFirst({ where: { storeId: STORE, fromSlug: 'old' } }))?.toSlug
  ).toBe('new2');
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test:integration -- slug-redirect`
Expected: FAIL — `recordSlugRedirect` not found.

- [ ] **Step 3: Implement the helper**

```ts
import { Prisma, SlugEntityType } from '@ebda/database';

/**
 * Record a slug rename so the old URL 301s to the new one.
 * Call inside the same transaction as the entity write. Ordering matters:
 * reuse-guard, then chain-collapse, then upsert.
 */
export async function recordSlugRedirect(
  tx: Prisma.TransactionClient,
  storeId: string,
  entityType: SlugEntityType,
  oldSlug: string,
  newSlug: string
): Promise<void> {
  if (!oldSlug || !newSlug || oldSlug === newSlug) return;

  // 1. Reuse guard — the new slug is live again, it must never redirect.
  await tx.slugRedirect.deleteMany({ where: { storeId, entityType, fromSlug: newSlug } });

  // 2. Chain-collapse — any redirect pointing at the old slug now points at the new one.
  await tx.slugRedirect.updateMany({
    where: { storeId, entityType, toSlug: oldSlug },
    data: { toSlug: newSlug },
  });

  // 3. Upsert old -> new.
  await tx.slugRedirect.upsert({
    where: { storeId_entityType_fromSlug: { storeId, entityType, fromSlug: oldSlug } },
    create: { storeId, entityType, fromSlug: oldSlug, toSlug: newSlug },
    update: { toSlug: newSlug },
  });
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm run test:integration -- slug-redirect`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/slug-redirect.service.ts apps/api/src/services/__tests__/slug-redirect.service.test.ts
git commit -m "feat(api): recordSlugRedirect helper with chain-collapse and reuse guard"
```

---

### Task 3: `resolveSlugRedirect` + public resolve endpoint

**Files:**

- Modify: `apps/api/src/services/slug-redirect.service.ts` (add resolver)
- Modify: `apps/api/src/routes/public.routes.ts` (add `GET /redirects/resolve`)
- Test: extend `apps/api/src/services/__tests__/slug-redirect.service.test.ts`; add a route test matching the repo's public-route test pattern

**Interfaces:**

- Consumes: `recordSlugRedirect` (seed data), Prisma client.
- Produces: `resolveSlugRedirect(storeId, entityType, slug): Promise<string | null>`; endpoint `GET /public/redirects/resolve?type=product|category|page|blog&slug=<s>` → `200 { toSlug }` or `404`.

- [ ] **Step 1: Write failing tests**

```ts
import { resolveSlugRedirect } from '../slug-redirect.service';

test('resolve returns final toSlug on hit', async () => {
  await prisma.$transaction(tx =>
    recordSlugRedirect(tx, STORE, SlugEntityType.PRODUCT, 'old', 'new')
  );
  expect(await resolveSlugRedirect(STORE, SlugEntityType.PRODUCT, 'old')).toBe('new');
});

test('resolve returns null on miss', async () => {
  expect(await resolveSlugRedirect(STORE, SlugEntityType.PRODUCT, 'nope')).toBeNull();
});

test('resolve backstops a legacy 2-hop row', async () => {
  // Simulate a legacy multi-hop the collapse would normally prevent.
  await prisma.slugRedirect.create({
    data: { storeId: STORE, entityType: SlugEntityType.PRODUCT, fromSlug: 'a', toSlug: 'b' },
  });
  await prisma.slugRedirect.create({
    data: { storeId: STORE, entityType: SlugEntityType.PRODUCT, fromSlug: 'b', toSlug: 'c' },
  });
  expect(await resolveSlugRedirect(STORE, SlugEntityType.PRODUCT, 'a')).toBe('c');
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test:integration -- slug-redirect`
Expected: FAIL — `resolveSlugRedirect` not found.

- [ ] **Step 3: Implement the resolver**

```ts
import { prisma } from '../lib/prisma'; // use the repo's shared client import; confirm path

export async function resolveSlugRedirect(
  storeId: string,
  entityType: SlugEntityType,
  slug: string
): Promise<string | null> {
  let current = slug;
  // Chain-collapse keeps this to one hop; cap defends against legacy rows/loops.
  for (let hops = 0; hops < 3; hops++) {
    const row = await prisma.slugRedirect.findUnique({
      where: { storeId_entityType_fromSlug: { storeId, entityType, fromSlug: current } },
    });
    if (!row) return current === slug ? null : current;
    if (row.toSlug === current) return current; // self-loop guard
    current = row.toSlug;
  }
  return current;
}
```

- [ ] **Step 4: Add the public endpoint**

In `apps/api/src/routes/public.routes.ts`, add (Zod-validate the query per repo convention):

```ts
// GET /public/redirects/resolve?type=product&slug=old-handle
router.get('/redirects/resolve', async (req, res) => {
  const storeId = req.header('X-Store-ID') || (req as any).storeId; // match how sibling public routes read the store
  const typeMap: Record<string, SlugEntityType> = {
    product: SlugEntityType.PRODUCT,
    category: SlugEntityType.CATEGORY,
    page: SlugEntityType.PAGE,
    blog: SlugEntityType.BLOG,
  };
  const entityType = typeMap[String(req.query.type)];
  const slug = String(req.query.slug || '');
  if (!storeId || !entityType || !slug) return res.status(400).json({ error: 'bad request' });
  const toSlug = await resolveSlugRedirect(storeId, entityType, slug);
  if (!toSlug) return res.status(404).json({ error: 'not found' });
  return res.json({ toSlug });
});
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm run test:integration -- slug-redirect` (+ the route test)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/slug-redirect.service.ts apps/api/src/routes/public.routes.ts apps/api/src/services/__tests__/slug-redirect.service.test.ts
git commit -m "feat(api): resolveSlugRedirect + public /redirects/resolve endpoint"
```

---

### Task 4: Capture on `ProductService.update`

**Files:**

- Modify: `apps/api/src/services/product.service.ts` (the `update` method, around the `finalSlug` computation ~721-815)
- Test: integration test asserting a rename creates the redirect

**Interfaces:**

- Consumes: `recordSlugRedirect` (Task 2), `SlugEntityType.PRODUCT`.

- [ ] **Step 1: Write failing integration test**

```ts
test('renaming a product slug records a PRODUCT redirect', async () => {
  const p = await ProductService.create(STORE, {
    name: 'Raw Pecan',
    slug: 'raw-pecan-2636297' /* required fields */,
  } as any);
  await ProductService.update(STORE, p.id, { slug: 'raw-pecan' } as any);
  const row = await prisma.slugRedirect.findFirst({
    where: { storeId: STORE, entityType: SlugEntityType.PRODUCT, fromSlug: 'raw-pecan-2636297' },
  });
  expect(row?.toSlug).toBe('raw-pecan');
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm run test:integration -- product.*slug|slug.*product` (or the file you added it to)
Expected: FAIL — no redirect row.

- [ ] **Step 3: Wire capture inside the update transaction**

`ProductService.update` must already write inside a transaction (confirm; if it uses a bare `prisma.product.update`, wrap the slug-change write + capture in `prisma.$transaction`). Immediately after the product row is updated with `finalSlug`, in the same `tx`:

```ts
if (data.slug && finalSlug !== product.slug) {
  await recordSlugRedirect(tx, storeId, SlugEntityType.PRODUCT, product.slug, finalSlug);
}
```

- [ ] **Step 4: Run, verify pass**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/product.service.ts apps/api/src/services/__tests__/
git commit -m "feat(api): capture product slug renames as redirects"
```

---

### Task 5: Capture on bulk + xlsx import

**Files:**

- Modify: `apps/api/src/services/bulk.service.ts` (existing-product update branch ~703-704)
- Modify: `apps/api/src/services/xlsx-import.ts` (matching branch)
- Test: integration test — importing a changed incoming handle for an existing product records the alias

**Interfaces:**

- Consumes: `recordSlugRedirect`, `SlugEntityType.PRODUCT`.

- [ ] **Step 1: Write failing test**

```ts
test('import records an alias when incoming handle differs, stored slug unchanged', async () => {
  const p = await ProductService.create(STORE, {
    name: 'Raw Pecan',
    slug: 'raw-pecan' /* ... */,
  } as any);
  await BulkService.import(STORE, [
    { /* row keyed to same product */ slug: 'raw-pecan-2636297', name: 'Raw Pecan' },
  ] as any);
  const stored = await prisma.product.findUnique({ where: { id: p.id } });
  expect(stored?.slug).toBe('raw-pecan'); // stored slug preserved (existing behavior)
  const row = await prisma.slugRedirect.findFirst({
    where: { storeId: STORE, entityType: SlugEntityType.PRODUCT, fromSlug: 'raw-pecan-2636297' },
  });
  expect(row?.toSlug).toBe('raw-pecan'); // incoming handle now redirects to the live one
});
```

- [ ] **Step 2: Run, verify fail.** Run: `npm run test:integration -- import`. Expected: FAIL.

- [ ] **Step 3: Wire capture**

In the existing-product update branch (where the code currently keeps `existing.slug`), when `row.slug` is present and `row.slug !== existing.slug`, inside the same tx:

```ts
if (row.slug && row.slug !== existing.slug) {
  await recordSlugRedirect(tx, storeId, SlugEntityType.PRODUCT, row.slug, existing.slug);
}
```

Apply the identical change in `xlsx-import.ts`. (Direction is intentional: the _incoming_ handle is the one search engines may have indexed from a prior export; it redirects to the live stored slug.)

- [ ] **Step 4: Run, verify pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/bulk.service.ts apps/api/src/services/xlsx-import.ts apps/api/src/services/__tests__/
git commit -m "feat(api): record import-handle aliases as product redirects"
```

---

### Task 6: Capture on Category, Page, Blog

**Files:**

- Modify: `apps/api/src/routes/category.routes.ts` (update handler ~24-45, write ~483) — wrap the slug-change write + capture in a transaction, or route through a service method
- Modify: `apps/api/src/services/pages.service.ts` (`upsert` ~249-292)
- Modify: `apps/api/src/services/blog.service.ts` (update path)
- Test: one integration test per entity asserting the redirect row

**Interfaces:**

- Consumes: `recordSlugRedirect`, `SlugEntityType.{CATEGORY,PAGE,BLOG}`.

- [ ] **Step 1: Write failing tests** — one per entity, mirroring Task 4's shape:

```ts
test('renaming a category slug records a CATEGORY redirect', async () => {
  /* create -> update slug -> assert row */
});
test('renaming a page slug records a PAGE redirect', async () => {
  /* pages.upsert old -> new -> assert row */
});
test('renaming a blog slug records a BLOG redirect', async () => {
  /* create -> update slug -> assert row */
});
```

- [ ] **Step 2: Run, verify fail.** Expected: FAIL (no rows).

- [ ] **Step 3: Wire capture at each site** — in the same transaction as each entity's slug write:

```ts
// category
if (data.slug && data.slug !== existing.slug)
  await recordSlugRedirect(tx, storeId, SlugEntityType.CATEGORY, existing.slug, data.slug);
// pages.service.upsert — when the addressed row's slug changes from prior.slug to the new normalized slug
if (prior && normalizedSlug !== prior.slug)
  await recordSlugRedirect(tx, storeId, SlugEntityType.PAGE, prior.slug, normalizedSlug);
// blog
if (data.slug && data.slug !== existing.slug)
  await recordSlugRedirect(tx, storeId, SlugEntityType.BLOG, existing.slug, data.slug);
```

If any of these writes is not already transactional, wrap the entity write + capture in `prisma.$transaction`.

- [ ] **Step 4: Run, verify pass.** Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/category.routes.ts apps/api/src/services/pages.service.ts apps/api/src/services/blog.service.ts apps/api/src/services/__tests__/
git commit -m "feat(api): capture category, page, and blog slug renames"
```

---

### Task 7: Storefront resolve-on-miss — product route (+ fix soft-404)

**Files:**

- Modify: `apps/web/src/app/products/[slug]/page.tsx` (server component)
- Modify: `apps/web/src/app/products/[slug]/ProductDetailBody.tsx` (stop rendering on null; let the server redirect/404)
- Create: `apps/web/src/lib/slug-redirect.ts` — `fetchSlugRedirect(storeId, type, slug): Promise<string | null>` calling the API endpoint
- Test: e2e (Task 9) covers the browser behavior; add a unit test for `fetchSlugRedirect` mapping 200/404

**Interfaces:**

- Consumes: API `GET /public/redirects/resolve`.
- Produces: `fetchSlugRedirect`.

- [ ] **Step 1: Write failing unit test for `fetchSlugRedirect`**

```ts
// mock fetch: 200 { toSlug } -> returns toSlug; 404 -> returns null
```

- [ ] **Step 2: Run, verify fail.** Expected: FAIL — not implemented.

- [ ] **Step 3: Implement `fetchSlugRedirect`** (mirror the existing `X-Store-ID` fetch pattern used in `page.tsx` line ~32):

```ts
export async function fetchSlugRedirect(
  storeId: string,
  type: 'product' | 'category' | 'page' | 'blog',
  slug: string
): Promise<string | null> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/public/redirects/resolve?type=${type}&slug=${encodeURIComponent(slug)}`,
    {
      headers: { 'X-Store-ID': storeId },
      cache: 'no-store',
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data?.toSlug === 'string' ? data.toSlug : null;
}
```

- [ ] **Step 4: Wire resolve-on-miss into `page.tsx`**

Where the product is fetched server-side and comes back null, before rendering:

```ts
import { permanentRedirect, notFound } from 'next/navigation';
import { fetchSlugRedirect } from '@/lib/slug-redirect';

// after product fetch returns null:
if (!product) {
  const toSlug = await fetchSlugRedirect(store.id, 'product', slug);
  if (toSlug && toSlug !== slug) permanentRedirect(`/products/${toSlug}`);
  notFound();
}
```

Then update `ProductDetailBody.tsx`: remove the `initialProduct={null}` soft-render path so a genuine miss reaches `notFound()` (the server now owns the miss decision). Confirm `not-found.tsx` renders for this segment.

- [ ] **Step 5: Run web unit tests + typecheck**

Run: `npm run typecheck && npm run test:unit -- slug-redirect`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/products/[slug]/page.tsx apps/web/src/app/products/[slug]/ProductDetailBody.tsx apps/web/src/lib/slug-redirect.ts apps/web/**/__tests__/
git commit -m "feat(web): 308-redirect renamed product handles and hard-404 real misses"
```

---

### Task 8: Storefront resolve-on-miss — category, page, blog routes

**Files:**

- Modify: the category storefront route server component
- Modify: the CMS page storefront route server component
- Modify: the blog post storefront route server component
  (Confirm exact paths + each route's base URL prefix from the route files before editing.)

**Interfaces:**

- Consumes: `fetchSlugRedirect` (Task 7).

- [ ] **Step 1: Wire each route's miss branch** — identical shape, correct type + base path:

```ts
if (!entity) {
  const toSlug = await fetchSlugRedirect(store.id, '<category|page|blog>', slug);
  if (toSlug && toSlug !== slug) permanentRedirect(`/<basePath>/${toSlug}`);
  notFound();
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/<category-route> apps/web/src/app/<page-route> apps/web/src/app/<blog-route>
git commit -m "feat(web): 308-redirect renamed category, page, and blog handles"
```

---

### Task 9: E2E, docs parity, blast-radius sweep

**Files:**

- Create/modify: an e2e spec under the repo's e2e dir
- Modify: `docs/runbooks/google-search-console-indexing.md`; add a note in `docs/architecture/` (redirect layer)

- [ ] **Step 1: E2E — rename then hit old URL**

```ts
// create a product, rename its slug via admin/API, GET the old storefront URL,
// assert a 308 to /products/<newSlug>; GET a never-existed slug, assert 404.
```

Run the repo's e2e command scoped to this spec. Expected: PASS.

- [ ] **Step 2: Docs parity**

State in the GSC runbook + architecture note: product/category/page/blog renames now self-redirect (308) via `SlugRedirect`; genuine misses now hard-404 (soft-404 removed). Store-level renames are phase 2.

- [ ] **Step 3: Blast-radius sweep — state the result in the PR**

```bash
# every capture site present?
grep -rn "recordSlugRedirect" apps/api/src
# every storefront miss branch wired?
grep -rn "fetchSlugRedirect" apps/web/src
# no stray consumers of the old soft-null product render?
grep -rn "initialProduct={null}" apps/web/src
# FK cascade confirmed in Task 1 Step 4
```

Report: `blast-radius: swept recordSlugRedirect (5 sites) + fetchSlugRedirect (4 routes) + SlugRedirect FK cascade + docs → clean`.

- [ ] **Step 4: Full gate**

Run: `npm run typecheck && npm run lint && npm run test` (unit+integration+e2e as CI runs them).
Expected: green.

- [ ] **Step 5: Commit + open PR**

```bash
git add docs apps
git commit -m "test(e2e): slug renames 308 to new url; docs parity for redirect layer"
```

Open the PR against `main`; let CI + the AI diff review run (never admin-merge past checks).

---

## Self-Review

**Spec coverage:** table (T1) · capture helper + guards (T2) · resolver + endpoint (T3) · product capture (T4) · import alias (T5) · category/page/blog capture (T6) · product resolve-on-miss + soft-404 fix (T7) · other-route resolve (T8) · e2e + docs + blast-radius (T9). Every spec section maps to a task.

**Placeholders:** wiring into existing functions cites exact files/anchors from the code map; the implementer confirms surrounding code (transaction boundaries, store-id read pattern, route base paths) — flagged explicitly rather than guessed, since those signatures weren't in scope to memorize. New code is fully literal.

**Type consistency:** `recordSlugRedirect` / `resolveSlugRedirect` / `fetchSlugRedirect` signatures and `SlugEntityType` members are identical across T2, T3, T7, T8.
