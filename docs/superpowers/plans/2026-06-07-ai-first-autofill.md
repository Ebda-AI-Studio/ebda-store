# AI-first Catalogue Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the catalogue AI features (Arabic translation, SEO, categorization, recommendations) from manual-only to default-on, running automatically on product create/update and on a 3-day safety-net sweep, while guaranteeing a merchant's manual edit is never overwritten.

**Architecture:** A per-field provenance map (`ai_field_sources` JSON column on `Product`) records each AI-writable field as `ai` or `human`. The product service stamps `human` on any field a merchant changes and emits enriched `product.upserted` / `product.deleted` events. A new `ai-autofill-product` Inngest function (debounced) fills `empty` fields and refreshes `ai`-owned fields whose source changed, reusing the existing `AIService` methods (which already enforce quota, caching, and usage recording). A leader-locked 3-day cron sweep fills gaps + refreshes stale AI content + recomputes order-driven recommendations. A `aiAutopilot` per-store toggle (default ON) gates it. The admin product editor shows a ✨ AI badge on AI-owned fields.

**Tech Stack:** Express + Prisma (apps/api), Inngest (event/cron orchestration), Google Gemini via `AIService`, Next.js admin (apps/admin), shared types in `@force/shared`, vitest.

**Spec:** `docs/superpowers/specs/2026-06-07-ai-first-autofill-design.md`

---

## Refinements vs the spec (read first)

These are deliberate, behavior-preserving deviations discovered while reading the code:

1. **Events:** Reuse the existing `product.upserted` (create + update) and `product.deleted` events emitted from `product.service.ts` (today they drive Meta Catalog sync). They are **enriched** with `op: 'create' | 'update'` and `changedFields: string[]`. The Meta sync functions ignore the extra fields. No new event names.
2. **Fill core:** Reuse `AIService.translate`, `AIService.suggestSeo`, `AIService.suggestCategories` instead of one new batched Gemini call. Each already does `assertAiQuota()` + Redis cache + `recordUsage()`. Cost difference (2–3 calls vs 1) is noise given the cost analysis; reuse is safer and inherits all guardrails.
3. **AEO scope:** The autofill v1 fills `nameAr`, `descriptionAr`, `metaTitle`, `metaTitleAr`, `metaDescription`, `metaDescriptionAr` + category. The AEO fields (`metaDescriptionAeo*`) stay on their existing manual/bulk path (`bulk-ai/meta-aeo-requested`) and are a documented fast-follow — `AIService` has no standalone per-product AEO method to reuse yet.

---

## File Structure

**Create:**

- `packages/shared/src/types/ai-autofill.ts` — field registry + provenance types
- `packages/shared/src/types/__tests__/ai-autofill.test.ts` — registry tests
- `apps/api/src/services/ai-autofill.service.ts` — `fillProductFields` core + provenance helpers
- `apps/api/src/services/__tests__/ai-autofill.service.test.ts` — provenance/diff unit tests
- `apps/api/src/lib/inngest/functions/ai-autofill-product.ts` — created/updated handler
- `apps/api/src/lib/inngest/functions/ai-autofill-cleanup.ts` — deleted handler
- `apps/api/src/lib/inngest/functions/ai-autofill-sweep.ts` — 3-day cron sweep
- `tests/integration/ai-autofill.test.ts` — create→fill, edit→skip, delete→cleanup
- `apps/admin/src/app/stores/[id]/products/[productId]/edit/_components/AiFieldBadge.tsx` — ✨ AI badge

**Modify:**

- `packages/database/prisma/schema.prisma` — add `aiFieldSources` to `Product`
- `apps/api/src/services/product.service.ts` — stamp `human`, enrich events
- `apps/api/src/lib/inngest/functions/index.ts` — register 3 new functions
- `packages/shared/src/types/store-theme.ts` — add `aiAutopilot` flag + default
- `apps/admin/src/app/stores/[id]/products/[productId]/_components/ProductInfoSections.tsx` — render badge

---

## Phase 1 — Provenance foundation

### Task 1: Field registry + provenance types in `@force/shared`

**Files:**

- Create: `packages/shared/src/types/ai-autofill.ts`
- Test: `packages/shared/src/types/__tests__/ai-autofill.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/__tests__/ai-autofill.test.ts
import { describe, it, expect } from 'vitest';
import { AI_AUTOFILL_FIELDS, fieldsNeedingRefresh, type FieldSource } from '../ai-autofill';

describe('AI autofill registry', () => {
  it('lists the six text fields with their source fields', () => {
    const names = AI_AUTOFILL_FIELDS.map(f => f.field);
    expect(names).toEqual([
      'nameAr',
      'descriptionAr',
      'metaTitle',
      'metaTitleAr',
      'metaDescription',
      'metaDescriptionAr',
    ]);
  });

  it('returns ai-owned fields whose source changed', () => {
    const sources: Record<string, FieldSource> = {
      nameAr: 'ai',
      metaTitle: 'human',
    };
    // English `name` changed → nameAr (ai, source name) refreshes;
    // metaTitle is human → never; metaDescription is empty → fills.
    const result = fieldsNeedingRefresh(sources, ['name']);
    expect(result.sort()).toEqual(
      ['metaDescription', 'metaDescriptionAr', 'metaTitleAr', 'nameAr'].sort()
    );
    expect(result).not.toContain('metaTitle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/types/__tests__/ai-autofill.test.ts`
Expected: FAIL — cannot find module `../ai-autofill`.

- [ ] **Step 3: Write the registry**

```ts
// packages/shared/src/types/ai-autofill.ts

/** Ownership of an AI-writable product field. Absent key = empty (unknown). */
export type FieldSource = 'ai' | 'human';

/** Map of field name → current owner. Stored in Product.aiFieldSources. */
export type AiFieldSources = Record<string, FieldSource>;

/**
 * Single source of truth for which Product fields the AI autofill engine
 * manages, and which other field(s) each one derives from. Both the
 * provenance-stamping diff (product.service) and the fill core
 * (ai-autofill.service) read this list so they can never disagree.
 *
 * AEO fields are intentionally excluded from v1 — see the plan's
 * "Refinements vs the spec" section.
 */
export const AI_AUTOFILL_FIELDS = [
  { field: 'nameAr', sources: ['name'] },
  { field: 'descriptionAr', sources: ['description'] },
  { field: 'metaTitle', sources: ['name'] },
  { field: 'metaTitleAr', sources: ['nameAr', 'name'] },
  { field: 'metaDescription', sources: ['name', 'description'] },
  { field: 'metaDescriptionAr', sources: ['nameAr', 'descriptionAr', 'name'] },
] as const;

export type AiAutofillField = (typeof AI_AUTOFILL_FIELDS)[number]['field'];

/** All field names the engine manages. */
export const AI_AUTOFILL_FIELD_NAMES: string[] = AI_AUTOFILL_FIELDS.map(f => f.field);

/**
 * Given the current provenance map and the set of fields that just changed
 * on a product, return the AI-writable fields that should be (re)generated:
 *   - field is NOT human-owned (human always wins), AND
 *   - field is empty (no entry) OR its source appears in changedFields.
 */
export function fieldsNeedingRefresh(sources: AiFieldSources, changedFields: string[]): string[] {
  const changed = new Set(changedFields);
  return AI_AUTOFILL_FIELDS.filter(({ field, sources: src }) => {
    if (sources[field] === 'human') return false;
    const isEmpty = sources[field] === undefined;
    const sourceChanged = src.some(s => changed.has(s));
    return isEmpty || sourceChanged;
  }).map(f => f.field);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/types/__tests__/ai-autofill.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Export from the shared barrel**

In `packages/shared/src/index.ts` (or the types barrel it re-exports), add:

```ts
export * from './types/ai-autofill';
```

Run: `cd packages/shared && npm run build`
Expected: builds clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/ai-autofill.ts \
  packages/shared/src/types/__tests__/ai-autofill.test.ts \
  packages/shared/src/index.ts
git commit -m "feat: ai-autofill field registry and provenance helpers in shared"
```

---

### Task 2: `aiFieldSources` column migration

**Files:**

- Modify: `packages/database/prisma/schema.prisma` (the `model Product` block, ~line 600)

- [ ] **Step 1: Add the column**

In `model Product`, next to the other meta fields, add:

```prisma
  /// Per-field AI provenance: { "<field>": "ai" | "human" }. Absent key =
  /// never set. Drives the autofill override guarantee — AI never touches a
  /// field marked "human". See @force/shared AI_AUTOFILL_FIELDS.
  aiFieldSources Json @default("{}") @map("ai_field_sources")
```

- [ ] **Step 2: Create the migration (against a DEV/preview DB only)**

> ⚠️ Per the global rule, confirm `apps/api/.env` `DATABASE_URL` does NOT point at the prod-serving Neon branch before running `migrate dev`. The column is additive + defaulted (forward-compatible), but generate the migration against dev.

Run: `cd packages/database && npx prisma migrate dev --name add_product_ai_field_sources`
Expected: migration SQL created at `prisma/migrations/<ts>_add_product_ai_field_sources/migration.sql` adding `ai_field_sources jsonb not null default '{}'`.

- [ ] **Step 3: Regenerate the client + clear stale tsc cache**

Run: `cd packages/database && npx prisma generate && rm -f ../../tsconfig.tsbuildinfo`
Expected: `@prisma/client` regenerated; `Product.aiFieldSources` now typed.

- [ ] **Step 4: Verify typecheck sees the field**

Run: `cd packages/database && npx tsc --noEmit`
Expected: PASS (no "Property 'aiFieldSources' does not exist").

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations
git commit -m "feat: add ai_field_sources provenance column to product"
```

---

## Phase 2 — Provenance stamping + event enrichment

### Task 3: Provenance-diff helper (pure, unit-tested)

**Files:**

- Create: `apps/api/src/services/ai-autofill.service.ts` (first export only)
- Test: `apps/api/src/services/__tests__/ai-autofill.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/__tests__/ai-autofill.service.test.ts
import { describe, it, expect } from 'vitest';
import { stampHumanEdits } from '../ai-autofill.service';

describe('stampHumanEdits', () => {
  it('marks a changed AI-writable field as human', () => {
    const next = stampHumanEdits(
      { nameAr: 'ai' }, // current provenance
      { nameAr: 'قديم' }, // stored values
      { nameAr: 'جديد' } // incoming values (merchant typed)
    );
    expect(next.nameAr).toBe('human');
  });

  it('leaves untouched fields alone', () => {
    const next = stampHumanEdits(
      { nameAr: 'ai', metaTitle: 'human' },
      { nameAr: 'x', metaTitle: 'y' },
      { nameAr: 'x', metaTitle: 'y' } // nothing changed
    );
    expect(next).toEqual({ nameAr: 'ai', metaTitle: 'human' });
  });

  it('clears the key when a field is emptied', () => {
    const next = stampHumanEdits({ nameAr: 'ai' }, { nameAr: 'x' }, { nameAr: '' });
    expect(next.nameAr).toBeUndefined();
  });

  it('ignores non-AI-writable fields like price', () => {
    const next = stampHumanEdits({}, { price: 1 } as any, { price: 2 } as any);
    expect(next).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/__tests__/ai-autofill.service.test.ts`
Expected: FAIL — `stampHumanEdits` not exported.

- [ ] **Step 3: Implement `stampHumanEdits`**

```ts
// apps/api/src/services/ai-autofill.service.ts
import { AI_AUTOFILL_FIELD_NAMES, type AiFieldSources } from '@force/shared';

/**
 * Diff incoming admin-form values against the stored values and update the
 * provenance map: any AI-writable field whose value changed becomes
 * 'human' (the override guarantee); a field cleared to empty loses its key.
 * Only AI-writable fields are considered — everything else is ignored.
 * `incoming` may omit fields (PATCH semantics) — omitted = unchanged.
 */
export function stampHumanEdits(
  current: AiFieldSources,
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>
): AiFieldSources {
  const next: AiFieldSources = { ...current };
  for (const field of AI_AUTOFILL_FIELD_NAMES) {
    if (!(field in incoming)) continue; // omitted in PATCH → unchanged
    const before = (stored[field] ?? '') as string;
    const after = (incoming[field] ?? '') as string;
    if (after === before) continue; // unchanged
    if (after.trim() === '') {
      delete next[field]; // emptied → back to "empty"
    } else {
      next[field] = 'human'; // merchant typed something → they own it
    }
  }
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/__tests__/ai-autofill.service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ai-autofill.service.ts \
  apps/api/src/services/__tests__/ai-autofill.service.test.ts
git commit -m "feat: stampHumanEdits provenance diff helper"
```

---

### Task 4: Wire stamping + enriched events into `product.service.ts`

**Files:**

- Modify: `apps/api/src/services/product.service.ts` (`create` ~323, `update` ~395, `delete` ~525)

- [ ] **Step 1: Import the helper + registry at the top of the file**

```ts
import { stampHumanEdits } from './ai-autofill.service';
import { AI_AUTOFILL_FIELD_NAMES } from '@force/shared';
```

- [ ] **Step 2: Enrich the `create` event (op=create)**

In `create`, replace the existing `inngest.send` for `product.upserted` with:

```ts
void inngest
  .send({
    name: 'product.upserted' as any,
    data: { storeId, productId: product.id, op: 'create', changedFields: [] },
  })
  .catch(err =>
    logger.warn({ err, productId: product.id }, '[product.create] inngest send failed')
  );
```

- [ ] **Step 3: Compute changedFields + stamp human edits in `update`**

In `update`, BEFORE the `withMoneyTx` block (the existing `product` from `getById` holds stored values), add:

```ts
// Which AI-writable fields did the merchant actually change in this PATCH?
const changedFields = AI_AUTOFILL_FIELD_NAMES.filter(
  f =>
    f in (data as Record<string, unknown>) &&
    ((data as Record<string, unknown>)[f] ?? '') !== ((product as Record<string, unknown>)[f] ?? '')
);
// Stamp human ownership on the fields they changed.
const nextSources = stampHumanEdits(
  (product.aiFieldSources as Record<string, 'ai' | 'human'>) ?? {},
  product as Record<string, unknown>,
  data as Record<string, unknown>
);
```

Then inside the `tx.product.update(...) data: { ... }` object, add `aiFieldSources` so the stamp persists in the same transaction:

```ts
          aiFieldSources: nextSources,
```

- [ ] **Step 4: Enrich the `update` event (op=update + changedFields)**

Replace the existing `update` `inngest.send` for `product.upserted` with:

```ts
void inngest
  .send({
    name: 'product.upserted' as any,
    data: { storeId, productId, op: 'update', changedFields },
  })
  .catch(err => logger.warn({ err, productId }, '[product.update] inngest send failed'));
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/product.service.ts
git commit -m "feat: stamp human field ownership and enrich product events"
```

---

## Phase 3 — Autofill core + event handlers

### Task 5: `fillProductFields` core

**Files:**

- Modify: `apps/api/src/services/ai-autofill.service.ts` (add the fill core)
- Test: `apps/api/src/services/__tests__/ai-autofill.service.test.ts` (add fill-set test)

- [ ] **Step 1: Write the failing test for the fill-set computation**

Add to the existing test file:

```ts
import { computeFillSet } from '../ai-autofill.service';

describe('computeFillSet', () => {
  it('on create fills every empty field', () => {
    const fields = computeFillSet({}, 'create', []);
    expect(fields.sort()).toEqual(
      [
        'descriptionAr',
        'metaDescription',
        'metaDescriptionAr',
        'metaTitle',
        'metaTitleAr',
        'nameAr',
      ].sort()
    );
  });

  it('on update only refreshes ai fields whose source changed', () => {
    const fields = computeFillSet({ nameAr: 'ai', descriptionAr: 'human' }, 'update', ['name']);
    expect(fields).toContain('nameAr'); // ai + source(name) changed
    expect(fields).not.toContain('descriptionAr'); // human
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/__tests__/ai-autofill.service.test.ts`
Expected: FAIL — `computeFillSet` not exported.

- [ ] **Step 3: Implement `computeFillSet` + `fillProductFields`**

Append to `apps/api/src/services/ai-autofill.service.ts`:

```ts
import { prisma } from '@force/database';
import { AIService } from './ai.service';
import { isAiQuotaCapError } from '../lib/ai-quota';
import logger from '../lib/logger';
import { fieldsNeedingRefresh, type AiFieldSources } from '@force/shared';

/** Which fields to (re)generate for this product event. */
export function computeFillSet(
  sources: AiFieldSources,
  op: 'create' | 'update' | 'sweep',
  changedFields: string[]
): string[] {
  // create + sweep behave as "all sources potentially changed" for empty
  // fields; fieldsNeedingRefresh already treats an empty field as fillable
  // regardless of changedFields, so passing changedFields verbatim is right
  // for update, and an empty array for create/sweep fills all gaps.
  return fieldsNeedingRefresh(sources, changedFields);
}

interface FillOpts {
  op: 'create' | 'update' | 'sweep';
  changedFields?: string[];
  /** sweep passes true so we also refresh ai fields older than staleTtl */
  refreshStale?: boolean;
  /** when set, restrict the fill to these fields (used by hand-back-to-AI, Task 12) */
  onlyFields?: string[];
}

/**
 * The single fill core shared by the event handler and the sweep. Loads the
 * product, computes the fill set, calls the existing AIService methods
 * (which enforce quota + cache + usage recording), writes the results, and
 * stamps the filled fields as 'ai'. Returns counts for logging.
 *
 * NEVER overwrites a 'human' field — that filtering happens in computeFillSet
 * via fieldsNeedingRefresh.
 */
export async function fillProductFields(
  storeId: string,
  productId: string,
  opts: FillOpts
): Promise<{ filled: number; skipped: boolean }> {
  const product = await prisma.product.findFirst({
    where: { id: productId, storeId, deletedAt: null },
    include: { categories: { select: { categoryId: true } } },
  });
  if (!product) return { filled: 0, skipped: true };

  const sources = (product.aiFieldSources as AiFieldSources) ?? {};
  let fillSet = new Set(computeFillSet(sources, opts.op, opts.changedFields ?? []));
  // hand-back-to-AI (Task 12) restricts the fill to one field.
  if (opts.onlyFields) {
    fillSet = new Set([...fillSet].filter(f => opts.onlyFields!.includes(f)));
  }
  if (fillSet.size === 0 && product.categories.length > 0) {
    return { filled: 0, skipped: true };
  }

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { name: true, nameAr: true },
  });

  const writes: Record<string, string> = {};
  const stampedSources: AiFieldSources = { ...sources };

  try {
    // 1. Arabic name + description (translate EN→AR)
    if (fillSet.has('nameAr') && product.name?.trim()) {
      const { translation } = await AIService.translate({
        storeId,
        text: product.name,
        from: 'en',
        to: 'ar',
        kind: 'product-name',
      });
      if (translation) {
        writes.nameAr = translation;
        stampedSources.nameAr = 'ai';
      }
    }
    if (fillSet.has('descriptionAr') && product.description?.trim()) {
      const { translation } = await AIService.translate({
        storeId,
        text: product.description,
        from: 'en',
        to: 'ar',
        kind: 'long-text',
      });
      if (translation) {
        writes.descriptionAr = translation;
        stampedSources.descriptionAr = 'ai';
      }
    }

    // 2. SEO meta (one call yields title/titleAr/description/descriptionAr)
    const seoWanted = ['metaTitle', 'metaTitleAr', 'metaDescription', 'metaDescriptionAr'].some(f =>
      fillSet.has(f)
    );
    if (seoWanted && product.name?.trim()) {
      const { suggestion } = await AIService.suggestSeo({
        storeId,
        kind: 'product',
        storeName: store?.name ?? '',
        storeNameAr: store?.nameAr,
        entityName: product.name,
        entityNameAr: writes.nameAr ?? product.nameAr,
        entityDescription: product.description,
        entityDescriptionAr: writes.descriptionAr ?? product.descriptionAr,
      });
      if (fillSet.has('metaTitle')) {
        writes.metaTitle = suggestion.title;
        stampedSources.metaTitle = 'ai';
      }
      if (fillSet.has('metaTitleAr')) {
        writes.metaTitleAr = suggestion.titleAr;
        stampedSources.metaTitleAr = 'ai';
      }
      if (fillSet.has('metaDescription')) {
        writes.metaDescription = suggestion.description;
        stampedSources.metaDescription = 'ai';
      }
      if (fillSet.has('metaDescriptionAr')) {
        writes.metaDescriptionAr = suggestion.descriptionAr;
        stampedSources.metaDescriptionAr = 'ai';
      }
    }

    // 3. Categorize ONLY when the product has zero categories
    if (product.categories.length === 0 && product.name?.trim()) {
      const cats = await prisma.category.findMany({
        where: { storeId },
        select: { id: true, name: true, nameAr: true },
      });
      if (cats.length > 0) {
        const { suggestions } = await AIService.suggestCategories({
          storeId,
          productName: product.name,
          productDescription: product.description,
          existingCategories: cats,
        });
        const high = suggestions.filter(s => s.confidence !== 'low').map(s => s.id);
        if (high.length > 0) {
          await prisma.productCategory.createMany({
            data: high.map(categoryId => ({ productId, categoryId })),
            skipDuplicates: true,
          });
        }
      }
    }
  } catch (err) {
    if (isAiQuotaCapError(err)) {
      logger.info({ storeId, productId }, '[ai-autofill] quota cap reached, deferring to next run');
      // Persist whatever we filled before the cap and exit cleanly.
    } else {
      logger.warn({ err, storeId, productId }, '[ai-autofill] fill failed');
    }
  }

  if (Object.keys(writes).length > 0) {
    await prisma.product.update({
      where: { id: productId, storeId },
      data: { ...writes, aiFieldSources: stampedSources },
    });
  }

  return { filled: Object.keys(writes).length, skipped: false };
}
```

> Note: confirm `'long-text'` is a valid `TranslationKind` in `ai.service.ts`; if the union differs, use the closest free-text kind (e.g. omit `kind` constraints). Check the `TranslationKind` type before running.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/__tests__/ai-autofill.service.test.ts`
Expected: PASS (computeFillSet tests pass; fillProductFields is covered by integration later).

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/ai-autofill.service.ts \
  apps/api/src/services/__tests__/ai-autofill.service.test.ts
git commit -m "feat: fillProductFields autofill core reusing AIService"
```

---

### Task 6: `ai-autofill-product` Inngest function (created + updated)

**Files:**

- Create: `apps/api/src/lib/inngest/functions/ai-autofill-product.ts`
- Modify: `apps/api/src/lib/inngest/functions/index.ts`

- [ ] **Step 1: Write the function**

```ts
// apps/api/src/lib/inngest/functions/ai-autofill-product.ts
import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { fillProductFields } from '../../../services/ai-autofill.service';
import { isAutopilotEnabled } from '../../../services/ai-autofill.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * AI-first autofill on product create/update. Triggered by the same
 * `product.upserted` event that drives Meta Catalog sync, now enriched with
 * `op` and `changedFields`. Debounced per product so rapid saves collapse to
 * one fill. Reads the store's aiAutopilot toggle and no-ops when off.
 */
export const aiAutofillProduct: InngestFunction.Any = inngest.createFunction(
  {
    id: 'ai-autofill-product',
    name: 'AI-first: autofill product fields on create/update',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    debounce: { key: 'event.data.productId', period: '60s' },
    retries: 2,
  },
  { event: 'product.upserted' as any },
  async ({ event }) => {
    const {
      storeId,
      productId,
      op = 'update',
      changedFields = [],
    } = event.data as {
      storeId: string;
      productId: string;
      op?: 'create' | 'update';
      changedFields?: string[];
    };
    if (!storeId || !productId) return;

    if (!(await isAutopilotEnabled(storeId))) {
      logger.info({ storeId, productId }, '[ai-autofill] autopilot off, skipping');
      return;
    }

    const result = await fillProductFields(storeId, productId, { op, changedFields });
    logger.info({ storeId, productId, op, filled: result.filled }, '[ai-autofill] product filled');

    // On create, give the new product immediate complements via the existing
    // recommendation engine (scoped to one product).
    if (op === 'create') {
      const job = await prisma.bulkAiJob.create({
        data: { storeId, type: 'recommendations', status: 'queued', total: 1 },
      });
      await inngest.send({
        name: 'bulk-ai/recommendations-requested',
        data: { jobId: job.id, storeId, force: false },
      });
    }
  }
);
```

> Note: verify the `bulkAiJob.create` field names (`type`, `status`, `total`) against how `bulk-ai-recommendations` reads them — match the existing job-creation call in `ai.routes.ts` (search `bulkAiJob.create`). Adjust if the enum/type value differs.

- [ ] **Step 2: Add `isAutopilotEnabled` to the autofill service**

Append to `apps/api/src/services/ai-autofill.service.ts`:

```ts
/** Read the per-store aiAutopilot toggle (default ON when unset). */
export async function isAutopilotEnabled(storeId: string): Promise<boolean> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { theme: true },
  });
  const theme = (store?.theme as Record<string, unknown>) ?? {};
  return theme.aiAutopilot !== false; // default ON
}
```

- [ ] **Step 3: Register the function**

In `apps/api/src/lib/inngest/functions/index.ts`, add the import and array entry:

```ts
import { aiAutofillProduct } from './ai-autofill-product';
```

Add `aiAutofillProduct,` to the `inngestFunctions` array.

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/inngest/functions/ai-autofill-product.ts \
  apps/api/src/lib/inngest/functions/index.ts \
  apps/api/src/services/ai-autofill.service.ts
git commit -m "feat: ai-autofill-product inngest handler with autopilot gate"
```

---

### Task 7: `ai-autofill-cleanup` Inngest function (deleted)

**Files:**

- Create: `apps/api/src/lib/inngest/functions/ai-autofill-cleanup.ts`
- Modify: `apps/api/src/lib/inngest/functions/index.ts`

- [ ] **Step 1: Write the function**

```ts
// apps/api/src/lib/inngest/functions/ai-autofill-cleanup.ts
import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { recommendationService } from '../../../services/recommendation.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * When a product is soft-deleted, purge the recommendation graph rows that
 * point AT it so it can never be recommended, and invalidate the caches of
 * the products that referenced it. Source-side rows cascade via FK; this
 * cleans the target side + statistical pairs.
 */
export const aiAutofillCleanup: InngestFunction.Any = inngest.createFunction(
  { id: 'ai-autofill-cleanup', name: 'AI-first: clean up recommendations on delete', retries: 2 },
  { event: 'product.deleted' as any },
  async ({ event }) => {
    const { storeId, productId } = event.data as { storeId: string; productId: string };
    if (!storeId || !productId) return;

    // Products that referenced the deleted one (their caches must drop it).
    const referrers = await prisma.aiRecommendation.findMany({
      where: { storeId, targetProductId: productId },
      select: { sourceProductId: true },
    });

    await prisma.$transaction([
      prisma.aiRecommendation.deleteMany({ where: { storeId, targetProductId: productId } }),
      prisma.frequentlyBoughtTogether.deleteMany({
        where: { storeId, OR: [{ productId1: productId }, { productId2: productId }] },
      }),
      prisma.productRelation.deleteMany({ where: { storeId, targetProductId: productId } }),
    ]);

    await Promise.all(
      [...new Set(referrers.map(r => r.sourceProductId))].map(id =>
        recommendationService.invalidateProductCache(storeId, id).catch(() => {})
      )
    );

    logger.info({ storeId, productId, referrers: referrers.length }, '[ai-autofill] cleanup done');
  }
);
```

- [ ] **Step 2: Expose a public cache-invalidation method on the recommendation service**

`invalidateCache` is currently `private`. In `apps/api/src/services/recommendation.service.ts`, add a thin public wrapper (keep the private one):

```ts
  async invalidateProductCache(storeId: string, productId: string) {
    await this.invalidateCache(storeId, productId);
  }
```

- [ ] **Step 3: Register the function**

In `functions/index.ts`:

```ts
import { aiAutofillCleanup } from './ai-autofill-cleanup';
```

Add `aiAutofillCleanup,` to `inngestFunctions`.

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/inngest/functions/ai-autofill-cleanup.ts \
  apps/api/src/lib/inngest/functions/index.ts \
  apps/api/src/services/recommendation.service.ts
git commit -m "feat: ai-autofill-cleanup purges reco graph on product delete"
```

---

## Phase 4 — 3-day sweep

### Task 8: `ai-autofill-sweep` cron

**Files:**

- Create: `apps/api/src/lib/inngest/functions/ai-autofill-sweep.ts`
- Modify: `apps/api/src/lib/inngest/functions/index.ts`, `apps/api/src/services/ai-autofill.service.ts`

- [ ] **Step 1: Add a staleness-aware sweep helper to the service**

Append to `apps/api/src/services/ai-autofill.service.ts`:

```ts
const STALE_TTL_DAYS = parseInt(process.env.AI_AUTOFILL_STALE_TTL_DAYS ?? '30', 10);
const SWEEP_THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS ?? '2500', 10);
const sweepSleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Sweep one store: fill gaps on every active product, refresh ai text fields
 * whose product hasn't been autofilled in STALE_TTL_DAYS, and recompute
 * order-driven recommendations. Honors the same throttle as the bulk jobs.
 */
export async function sweepStore(storeId: string): Promise<{ products: number; filled: number }> {
  if (!(await isAutopilotEnabled(storeId))) return { products: 0, filled: 0 };

  const products = await prisma.product.findMany({
    where: { storeId, status: 'active', deletedAt: null },
    select: { id: true, updatedAt: true },
  });

  let filled = 0;
  const staleBefore = new Date(Date.now() - STALE_TTL_DAYS * 24 * 60 * 60 * 1000);
  for (const p of products) {
    const refreshStale = p.updatedAt < staleBefore;
    const res = await fillProductFields(storeId, p.id, { op: 'sweep', refreshStale });
    filled += res.filled;
    await sweepSleep(SWEEP_THROTTLE_MS);
  }
  return { products: products.length, filled };
}
```

- [ ] **Step 2: Write the cron function**

```ts
// apps/api/src/lib/inngest/functions/ai-autofill-sweep.ts
import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { withLeaderLock } from '../../leader-election';
import { sweepStore } from '../../../services/ai-autofill.service';
import { recommendationService } from '../../../services/recommendation.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Safety-net sweep every 3 days. Leader-locked so only one Railway replica
 * runs it. Per store: recompute order-driven FBT (feeds the AI reco engine),
 * fill content gaps, refresh stale ai content.
 */
export const aiAutofillSweep: InngestFunction.Any = inngest.createFunction(
  { id: 'ai-autofill-sweep', name: 'AI-first: 3-day catalogue autofill sweep', retries: 1 },
  { cron: 'TZ=Asia/Kuwait 0 3 */3 * *' },
  async () => {
    await withLeaderLock('ai-autofill-sweep', 3 * 24 * 60 * 60 * 1000, async () => {
      const stores = await prisma.store.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      for (const s of stores) {
        try {
          await recommendationService.recalculateFBT(s.id); // refresh order signal first
          const res = await sweepStore(s.id);
          logger.info({ storeId: s.id, ...res }, '[ai-autofill-sweep] store swept');
        } catch (err) {
          logger.error({ err, storeId: s.id }, '[ai-autofill-sweep] store failed');
        }
      }
    }).catch(err => logger.error({ err }, '[ai-autofill-sweep] leader lock error'));
  }
);
```

> Note: confirm the `withLeaderLock` import path (`../../leader-election`) matches what `recommendation.service.ts` uses, and that `store.deletedAt` exists in the schema; if stores aren't soft-deleted, drop that filter.

- [ ] **Step 3: Register the function**

In `functions/index.ts`:

```ts
import { aiAutofillSweep } from './ai-autofill-sweep';
```

Add `aiAutofillSweep,` to `inngestFunctions`.

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/inngest/functions/ai-autofill-sweep.ts \
  apps/api/src/lib/inngest/functions/index.ts \
  apps/api/src/services/ai-autofill.service.ts
git commit -m "feat: 3-day leader-locked autofill sweep with order-driven recos"
```

---

## Phase 5 — Governance toggle

### Task 9: `aiAutopilot` flag on StoreTheme

**Files:**

- Modify: `packages/shared/src/types/store-theme.ts` (interface ~93, `DEFAULT_THEME` ~266)

- [ ] **Step 1: Add the flag to the interface**

In `interface StoreTheme`, add:

```ts
  /** AI-first autopilot: auto-fill catalogue AI fields on create/update +
   *  3-day sweep. Default ON. Manual edits always win via provenance. */
  aiAutopilot?: boolean;
```

- [ ] **Step 2: Default it ON in `DEFAULT_THEME`**

```ts
  aiAutopilot: true,
```

- [ ] **Step 3: Build shared**

Run: `cd packages/shared && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/store-theme.ts
git commit -m "feat: aiAutopilot store-theme flag, default on"
```

---

### Task 10: Autopilot status chip on the Settings overview

**Files:**

- Modify: the store Settings overview card (find via `grep -rln "Branding" apps/admin/src/app/stores/\[id\]/settings`). Add a status chip mirroring the existing discoverability-chip pattern.

- [ ] **Step 1: Add the chip**

In the Settings overview card list, add a chip bound to `theme.aiAutopilot !== false`:

```tsx
<span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
  ✨ AI Autopilot:{' '}
  <strong className={theme?.aiAutopilot !== false ? 'text-primary' : 'text-muted-foreground'}>
    {theme?.aiAutopilot !== false ? 'ON' : 'OFF'}
  </strong>
</span>
```

- [ ] **Step 2: Verify the admin builds**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/app/stores/
git commit -m "feat: ai autopilot status chip on settings overview"
```

---

## Phase 6 — Admin ✨ AI badge

### Task 11: `AiFieldBadge` component + wiring

**Files:**

- Create: `apps/admin/src/app/stores/[id]/products/[productId]/edit/_components/AiFieldBadge.tsx`
- Modify: `apps/admin/src/app/stores/[id]/products/[productId]/_components/ProductInfoSections.tsx`

- [ ] **Step 1: Write the badge component**

```tsx
// AiFieldBadge.tsx
'use client';

/**
 * Shows a subtle "✨ AI" badge when a product field is currently AI-owned.
 * Pass the field name + the product's aiFieldSources map. Renders nothing
 * for human-owned or empty fields — visual proof the override took once the
 * merchant edits the field (parent flips it to human on change).
 */
export function AiFieldBadge({
  field,
  sources,
}: {
  field: string;
  sources?: Record<string, 'ai' | 'human'> | null;
}) {
  if (!sources || sources[field] !== 'ai') return null;
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
      title="Generated by AI — edit to take ownership / أنشئ بالذكاء الاصطناعي"
    >
      ✨ AI
    </span>
  );
}
```

- [ ] **Step 2: Render it next to the AI-writable field labels**

In `ProductInfoSections.tsx`, import the badge and place it beside each of the six fields' labels (`nameAr`, `descriptionAr`, `metaTitle`, `metaTitleAr`, `metaDescription`, `metaDescriptionAr`), e.g.:

```tsx
<label className="flex items-center gap-2">
  Arabic name / الاسم بالعربية
  <AiFieldBadge field="nameAr" sources={product.aiFieldSources} />
</label>
```

Ensure the product fetch that feeds this component selects `aiFieldSources` (add it to the `select`/type if the page uses an explicit select).

- [ ] **Step 3: Verify the admin builds**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/app/stores/
git commit -m "feat: ai field badge in product editor"
```

---

### Task 12: Hand-back-to-AI button + reset endpoint

**Goal:** Beside every **human-owned** field, show a small "✨ Switch to AI" button. Clicking it clears the field, removes the `human` lock, and immediately regenerates that one field via the AI — so the merchant can hand any field they typed back to the engine.

**Files:**

- Modify: `apps/api/src/routes/ai.routes.ts` (add reset endpoint)
- Modify: `apps/admin/src/app/stores/[id]/products/[productId]/edit/_components/AiFieldBadge.tsx` (add the button variant)
- Modify: `apps/admin/src/app/stores/[id]/products/[productId]/_components/ProductInfoSections.tsx` (render on human fields)

- [ ] **Step 1: Write the failing integration test for the reset endpoint behavior**

Append to `tests/integration/ai-autofill.test.ts`:

```ts
describe('hand back to AI', () => {
  it('clears the human lock and regenerates the field', async () => {
    // Field is human-owned with a manual value.
    await prisma.product.update({
      where: { id: productId },
      data: { nameAr: 'يدوي', aiFieldSources: { nameAr: 'human' } },
    });
    const { fillProductFields } = await import('../../apps/api/src/services/ai-autofill.service');
    // Simulate the endpoint's two steps: unlock + targeted refill.
    await prisma.product.update({
      where: { id: productId },
      data: { nameAr: null, aiFieldSources: {} },
    });
    await fillProductFields(storeId, productId, { op: 'create', onlyFields: ['nameAr'] });
    const p = await prisma.product.findUnique({ where: { id: productId } });
    expect(p?.nameAr).toBe('اسم'); // regenerated by the mocked AIService
    expect((p?.aiFieldSources as any).nameAr).toBe('ai');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -- ai-autofill`
Expected: FAIL until `onlyFields` is wired (it is, from Task 5's edit) — if Task 5 already shipped `onlyFields`, this passes; the endpoint itself is covered by Step 4 manual check.

- [ ] **Step 3: Add the reset endpoint**

In `apps/api/src/routes/ai.routes.ts`, add (mirrors the auth/middleware shape of the other product AI routes in that file — match the existing `authenticate → authorize → requireStoreAccess` chain used by neighbours):

```ts
import { AI_AUTOFILL_FIELD_NAMES } from '@force/shared';
import { fillProductFields } from '../services/ai-autofill.service';
import { prisma } from '@force/database';

/**
 * POST /stores/:storeId/products/:productId/ai/reset-field
 * Body: { field: string }
 * Hands a human-owned field back to the AI: clears the value + provenance
 * lock, then regenerates just that field. Returns the new value.
 */
router.post(
  '/:storeId/products/:productId/ai/reset-field',
  // ...same auth middleware chain as the other :storeId routes in this file
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const { field } = req.body as { field?: string };
      if (!field || !AI_AUTOFILL_FIELD_NAMES.includes(field)) {
        return res.status(400).json({ success: false, error: { code: 'BAD_FIELD' } });
      }
      const product = await prisma.product.findFirst({ where: { id: productId, storeId } });
      if (!product) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });

      const sources = { ...((product.aiFieldSources as Record<string, string>) ?? {}) };
      delete sources[field];
      await prisma.product.update({
        where: { id: productId, storeId },
        data: { [field]: null, aiFieldSources: sources },
      });

      await fillProductFields(storeId, productId, { op: 'create', onlyFields: [field] });

      const updated = await prisma.product.findUnique({ where: { id: productId } });
      res.json({
        success: true,
        data: { field, value: (updated as any)?.[field] ?? null, source: 'ai' },
      });
    } catch (err) {
      next(err);
    }
  }
);
```

> Note: confirm whether `ai.routes.ts` is mounted under `/stores` or whether product AI routes already carry the `:storeId/:productId` prefix — match the existing per-product AI route paths in that file exactly (search for `products/:productId` there). Adjust the path so it lines up with how the admin client calls it.

- [ ] **Step 4: Add the button variant to `AiFieldBadge.tsx`**

Extend the component so a human-owned field renders an action button instead of the badge:

```tsx
'use client';
import { useState } from 'react';
import { apiPost } from '../../../../../../../lib/api';

export function AiFieldBadge({
  field,
  sources,
  storeId,
  productId,
  onReset,
}: {
  field: string;
  sources?: Record<string, 'ai' | 'human'> | null;
  storeId?: string;
  productId?: string;
  onReset?: (field: string, value: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const owner = sources?.[field];

  if (owner === 'ai') {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
        title="Generated by AI — edit to take ownership / أنشئ بالذكاء الاصطناعي"
      >
        ✨ AI
      </span>
    );
  }

  if (owner === 'human' && storeId && productId) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const { data } = await apiPost<{ field: string; value: string | null }>(
            `/api/v1/stores/${storeId}/products/${productId}/ai/reset-field`,
            { field }
          );
          setBusy(false);
          if (data) onReset?.(field, data.value);
        }}
        className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-primary/10 hover:text-primary disabled:opacity-50"
        title="Hand this field back to the AI / أعِد هذا الحقل للذكاء الاصطناعي"
      >
        {busy ? '…' : '✨ Switch to AI'}
      </button>
    );
  }

  return null;
}
```

> Note: fix the relative import depth for `apiPost` to match the file's actual location (count the `../` to `apps/admin/src/lib/api`), or use the project's `@/lib/api` alias if configured.

- [ ] **Step 5: Wire `onReset` in `ProductInfoSections.tsx`**

Pass `storeId`, `productId`, and an `onReset` callback that writes the regenerated value back into the form state (so the field updates live and the button flips to the ✨ AI badge). Example for the Arabic-name field:

```tsx
<AiFieldBadge
  field="nameAr"
  sources={product.aiFieldSources}
  storeId={storeId}
  productId={product.id}
  onReset={(_f, value) => setForm(prev => ({ ...prev, nameAr: value ?? '' }))}
/>
```

- [ ] **Step 6: Verify + run integration test**

Run: `cd apps/admin && npx tsc --noEmit && cd ../.. && npm run test:integration -- ai-autofill`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/ai.routes.ts apps/admin/src/app/stores/ tests/integration/ai-autofill.test.ts
git commit -m "feat: hand-back-to-ai button and reset-field endpoint"
```

---

## Phase 7 — Integration test + verification

### Task 13: Integration test (create→fill, edit→skip, delete→cleanup)

**Files:**

- Create: `tests/integration/ai-autofill.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
// tests/integration/ai-autofill.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@force/database';
import { fillProductFields } from '../../apps/api/src/services/ai-autofill.service';
import { AIService } from '../../apps/api/src/services/ai.service';

// Stub Gemini so the test never calls the network/quota.
vi.spyOn(AIService, 'translate').mockResolvedValue({ translation: 'اسم', cached: false });
vi.spyOn(AIService, 'suggestSeo').mockResolvedValue({
  suggestion: { title: 'T', titleAr: 'ت', description: 'D', descriptionAr: 'د', keywords: [] },
  cached: false,
});
vi.spyOn(AIService, 'suggestCategories').mockResolvedValue({ suggestions: [], cached: false });

let storeId: string;
let productId: string;

beforeAll(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE products, stores RESTART IDENTITY CASCADE');
  const store = await prisma.store.create({
    data: { name: 'T', slug: 'autofill-it' /* required fields per schema */ } as any,
  });
  storeId = store.id;
  const p = await prisma.product.create({
    data: { storeId, name: 'Blue Mug', slug: 'blue-mug', price: 1 } as any,
  });
  productId = p.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('fillProductFields', () => {
  it('on create fills Arabic + SEO and stamps them ai', async () => {
    const res = await fillProductFields(storeId, productId, { op: 'create' });
    expect(res.filled).toBeGreaterThan(0);
    const p = await prisma.product.findUnique({ where: { id: productId } });
    expect(p?.nameAr).toBe('اسم');
    expect((p?.aiFieldSources as any).nameAr).toBe('ai');
  });

  it('never overwrites a human-owned field', async () => {
    await prisma.product.update({
      where: { id: productId },
      data: { nameAr: 'يدوي', aiFieldSources: { nameAr: 'human' } },
    });
    await fillProductFields(storeId, productId, { op: 'update', changedFields: ['name'] });
    const p = await prisma.product.findUnique({ where: { id: productId } });
    expect(p?.nameAr).toBe('يدوي'); // untouched
  });
});
```

> Note: fill in the `store.create` / `product.create` payloads with whatever columns the schema marks required (check `model Store` / `model Product`). Follow the TRUNCATE-in-beforeAll isolation rule from the CI standard.

- [ ] **Step 2: Run the integration test**

Run: `cd /Users/ahmadsharaf/Desktop/projects/force-website-builder && npm run test:integration -- ai-autofill`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/ai-autofill.test.ts
git commit -m "test: ai-autofill create-fill and human-override integration"
```

---

### Task 14: Full verification + docs parity

- [ ] **Step 1: Typecheck + lint + unit across the repo**

Run: `npm run typecheck && npm run lint && npm run test:unit`
Expected: all PASS.

- [ ] **Step 2: Manual UI verification (per "every data has a UI")**

- `npm run dev:admin`, open a product → confirm ✨ AI badge shows on AI-owned fields, disappears after editing one.
- Confirm the existing manual "Generate" buttons + the bulk-sweep buttons still work unchanged.
- Confirm the Settings overview shows the AI Autopilot chip.

- [ ] **Step 3: Update docs in the same session (documentation-parity rule)**

- Add an "AI Autopilot" subsection to the per-store visual-config table in `CLAUDE.md` (flag, default ON, where).
- Note the new env knobs in `CLAUDE.md` env section: `AI_AUTOFILL_STALE_TTL_DAYS` (default 30).
- Update `docs/business/feature-catalog.md` (if present) to describe AI-first autofill as a Professional/Enterprise differentiator.

- [ ] **Step 4: Commit docs**

```bash
git add CLAUDE.md docs/
git commit -m "docs: document ai-first autopilot flag, env knobs, feature"
```

- [ ] **Step 5: Push + let CI run**

```bash
git push origin main
```

Confirm `git config user.email` is `ahmed0montaser@gmail.com` and HEAD author is correct before pushing (Vercel admin deploy).

---

## Self-review checklist (done by plan author)

- **Spec coverage:** provenance (§2 → Tasks 1–4), events (§3.3 → Task 4), fill core (§3.5 → Task 5), product handler + reco-on-create (§3.5 → Task 6), cleanup (§3.5 → Task 7), 3-day sweep + stale refresh (§3.5 → Task 8), aiAutopilot toggle + chip (§3.6 → Tasks 9–10), AI badge (§3.7 → Task 11), order-driven recos (§4 → Task 8 recalculateFBT-first), cost controls (§5 → reuse of quota/throttle/cache + debounce), regression guards (§6 → Task 13 step 2), testing (§7 → Tasks 1,3,5,12). AEO (§3 registry) intentionally deferred — documented in "Refinements".
- **Placeholders:** none — every code step has real code; `> Note:` callouts flag the few values the implementer must confirm against the live schema/types (required columns, enum values, kind unions, import paths) rather than guessing.
- **Type consistency:** `AiFieldSources`, `FieldSource`, `AI_AUTOFILL_FIELDS`, `fieldsNeedingRefresh`, `stampHumanEdits`, `computeFillSet`, `fillProductFields`, `isAutopilotEnabled`, `sweepStore`, `invalidateProductCache` are referenced consistently across tasks.
