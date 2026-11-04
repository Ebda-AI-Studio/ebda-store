import { AI_AUTOFILL_FIELD_NAMES, fieldsNeedingRefresh, type AiFieldSources } from '@ebda/shared';
import { storeDb, storeRepo, storeWriter } from '../lib/repo-factory';
import { prisma, withStore, hasTenantContext, runInTenantContext } from '@ebda/database';
import { AIService } from './ai.service';
import { isAiQuotaCapError } from '../lib/ai-quota';
import { containsArabic } from '../lib/ai/description-richness';
import logger from '../lib/logger';
import { inngest } from '../lib/inngest/client';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { withSavepoint } from '../lib/savepoint';
import { markJobFailedOnEnqueueError } from '../lib/jobs/enqueue-fail';
import { config } from '../config';
import { generateProductSearchTerms } from '../lib/ai/product-search-terms-generator';
import { requestStoreReindex, touchesEmbedDoc } from '../lib/search/reindex';
import { isStoreAiEnabled } from '../lib/store-ai-switch';

/**
 * Diff incoming admin-form values against the stored values and update the
 * provenance map: any AI-writable field whose value changed becomes 'human'
 * (the override guarantee) — INCLUDING a field the merchant explicitly
 * emptied. A clear is an edit, not an absence.
 *
 * Dropping the key on a clear (the original behaviour) left
 * `sources[field] === undefined`, which `fieldsNeedingRefresh` reads as an
 * empty gap to fill. `product.upserted` fires right after this save, so the
 * autopilot would re-translate the cleared field from its still-populated
 * sibling language and stamp it 'ai' — for a bilingual product (the common
 * case here) the merchant's clear reappeared as fresh AI text seconds later,
 * burning Gemini quota on every such save. 'human' is the one stamp the fill
 * engine never overrides. Merchants who want AI to own the field again use
 * the "✨ Switch to AI" hand-back endpoint, which deletes the key itself.
 *
 * Only AI-writable fields are considered. `incoming` may omit fields (PATCH
 * semantics) — omitted = unchanged.
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
    if (after === before) continue;
    // Whitespace churn between two effectively-empty values (e.g. '' → '  '
    // on create) is not an edit — leave the field a fillable gap.
    if (String(after).trim() === '' && String(before).trim() === '') continue;
    next[field] = 'human';
  }
  return next;
}

/** Which fields to (re)generate for this product event. */
export function computeFillSet(
  sources: AiFieldSources,
  _op: 'create' | 'update' | 'sweep',
  changedFields: string[],
  refreshStale = false
): string[] {
  // fieldsNeedingRefresh already treats an empty field as fillable regardless
  // of changedFields, so create/sweep (which pass []) fill all gaps, and
  // update fills gaps + refreshes ai fields whose source changed.
  const base = fieldsNeedingRefresh(sources, changedFields);
  if (!refreshStale) return base;
  // Stale-refresh (daily sweep on a long-untouched product): also regenerate
  // every ai-owned field so improved prompts / fresh context propagate.
  // human-owned fields are still never touched.
  const aiOwned = AI_AUTOFILL_FIELD_NAMES.filter(f => sources[f] === 'ai');
  return [...new Set([...base, ...aiOwned])];
}

interface FillOpts {
  op: 'create' | 'update' | 'sweep';
  changedFields?: string[];
  refreshStale?: boolean;
  /** when set, restrict the fill to these fields (used by hand-back-to-AI) */
  onlyFields?: string[];
}

/**
 * What the fill read, as plain JSON (it is an Inngest step output, review I2). `values` is the
 * baseline every write is checked against at write time (review I1).
 */
export interface FillPlan {
  storeId: string;
  productId: string;
  fillSet: string[];
  values: Record<string, string | null>;
  sources: AiFieldSources;
  /** names of the product's own categories (ar, en); empty when it has none */
  categoryNames: string[];
  hasCategories: boolean;
  /** the store's categories, read only when the product has none (categorize input) */
  storeCategories: Array<{ id: string; name: string; nameAr: string | null }>;
  storeName: string;
  storeNameAr: string | null;
}

/** What the AI produced, as plain JSON (an Inngest step output: a retry never pays twice). */
export interface FillGeneration {
  writes: Record<string, string>;
  pickedCategoryIds: string[];
  /** provider calls actually made (cache hits excluded): the sweep paces on it (review I4) */
  calls: number;
  /** a provider 429 stopped this run: the sweep backs off (review I4) */
  rateLimited: boolean;
  /** a platform / store / budget cap stopped this run: terminal until the window resets */
  capped: boolean;
}

export interface FillResult {
  filled: number;
  skipped: boolean;
  calls: number;
  rateLimited: boolean;
  capped: boolean;
}

/** Provider 429s seen by this isolate; logged with every one so a burst is visible (I4). */
let rateLimitedTotal = 0;

const nameOf = (c: { name: string | null; nameAr: string | null }) =>
  [c.nameAr, c.name].filter((v): v is string => !!v);

/**
 * Phase 1 — READ (short; the Inngest function runs it in one tenant transaction). Returns null
 * when the product is gone or there is nothing to do.
 */
export async function readFillPlan(
  storeId: string,
  productId: string,
  opts: FillOpts
): Promise<FillPlan | null> {
  const product = await (
    await storeDb(storeId)
  ).product.findFirst({
    where: { id: productId, storeId, deletedAt: null },
    include: { categories: { select: { categoryId: true } } },
  });
  if (!product) return null;
  // The merchant's AI switch: off means the autopilot and every sweep leave the product alone.
  if (!(await isStoreAiEnabled(storeId))) return null;

  const sources = (product.aiFieldSources as AiFieldSources) ?? {};
  let fillSet = new Set(
    computeFillSet(sources, opts.op, opts.changedFields ?? [], opts.refreshStale ?? false)
  );
  if (opts.onlyFields) {
    fillSet = new Set([...fillSet].filter(f => opts.onlyFields!.includes(f)));
  }
  const hasCategories = product.categories.length > 0;
  if (fillSet.size === 0 && hasCategories) return null;

  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { name: true, nameAr: true },
    })
  );
  const categoryNames = hasCategories
    ? (
        await (
          await storeDb(storeId)
        ).category.findMany({
          where: { storeId, id: { in: product.categories.map(c => c.categoryId) } },
          select: { name: true, nameAr: true },
        })
      ).flatMap(nameOf)
    : [];
  const storeCategories = hasCategories
    ? []
    : await (
        await storeDb(storeId)
      ).category.findMany({
        where: { storeId },
        select: { id: true, name: true, nameAr: true },
      });

  const row = product as unknown as Record<string, unknown>;
  return {
    storeId,
    productId,
    fillSet: [...fillSet],
    values: Object.fromEntries(
      AI_AUTOFILL_FIELD_NAMES.map(f => [f, (row[f] as string | null | undefined) ?? null])
    ),
    sources,
    categoryNames,
    hasCategories,
    storeCategories,
    storeName: store?.name ?? '',
    storeNameAr: store?.nameAr ?? null,
  };
}

/**
 * Phase 2 — GENERATE. AI calls only; holds NO transaction (review I2: run it under
 * `runInStoreScope`, where the quota checks, cache reads and usage rows are each their own
 * short statement). Usage is recorded at spend time by the AI layer, so a write that later
 * fails or is skipped never hides real spend (Ruling SEARCH-T8-6).
 */
export async function generateFill(plan: FillPlan): Promise<FillGeneration> {
  const { storeId, productId, values: product, sources } = plan;
  const fillSet = new Set(plan.fillSet);
  const writes: Record<string, string> = {};
  const out: FillGeneration = {
    writes,
    pickedCategoryIds: [],
    calls: 0,
    rateLimited: false,
    capped: false,
  };
  const spent = (cached: boolean) => {
    if (!cached) out.calls++;
  };

  // A field is a safe write target only if it's in the fill set AND either
  // currently empty OR explicitly ai-owned (a refresh). This is the crucial
  // guard for LEGACY/pre-feature products whose `aiFieldSources` is `{}`: such
  // a product can have real human-written content with no provenance entry, so
  // computeFillSet treats it as "empty" — without this value check the engine
  // would OVERWRITE that human content. Never write over existing content that
  // isn't ours. (applyFill re-checks every field against the row at write time.)
  const canWrite = (field: string, currentVal: string | null | undefined): boolean =>
    fillSet.has(field) && (!currentVal?.trim() || sources[field] === 'ai');

  try {
    // EN/AR content pairs — translate in WHICHEVER direction is needed. The
    // `&& <source>?.trim()` guard means we only translate when the source
    // language actually has content, so the mutual sourcing never loops and a
    // both-empty pair is simply skipped.
    const pairs: Array<[string, string, 'ar' | 'en', 'product-name' | 'product-description']> = [
      ['name', 'nameAr', 'ar', 'product-name'], // AR → EN (Arabic-first merchant)
      ['nameAr', 'name', 'en', 'product-name'], // EN → AR
      ['description', 'descriptionAr', 'ar', 'product-description'],
      ['descriptionAr', 'description', 'en', 'product-description'],
    ];
    for (const [target, source, from, kind] of pairs) {
      const text = product[source];
      if (canWrite(target, product[target]) && text?.trim()) {
        const { translation, cached } = await AIService.translate({
          storeId,
          text,
          from,
          to: from === 'ar' ? 'en' : 'ar',
          kind,
        });
        spent(cached);
        if (translation) writes[target] = translation;
      }
    }

    // Prefer values written this run (freshly translated) over the stored ones,
    // so SEO reflects the just-filled language.
    const effName = writes.name ?? product.name;
    const effNameAr = writes.nameAr ?? product.nameAr;
    const effDescription = writes.description ?? product.description;
    const effDescriptionAr = writes.descriptionAr ?? product.descriptionAr;

    const seoWanted = ['metaTitle', 'metaTitleAr', 'metaDescription', 'metaDescriptionAr'].some(f =>
      fillSet.has(f)
    );
    // Run when there's product content in EITHER language.
    if (seoWanted && (effName?.trim() || effNameAr?.trim())) {
      const { suggestion, cached } = await AIService.suggestSeo({
        storeId,
        kind: 'product',
        storeName: plan.storeName,
        storeNameAr: plan.storeNameAr,
        entityName: effName || effNameAr || '',
        entityNameAr: effNameAr,
        entityDescription: effDescription,
        entityDescriptionAr: effDescriptionAr,
      });
      spent(cached);
      // Guard each write against an empty/whitespace value — Gemini can return
      // "" for a sparse product, and writing it would stamp the field 'ai' and
      // lock the empty value in (never re-filled until a source changes).
      const seo: Array<[string, string | undefined]> = [
        ['metaTitle', suggestion.title],
        ['metaTitleAr', suggestion.titleAr],
        ['metaDescription', suggestion.description],
        ['metaDescriptionAr', suggestion.descriptionAr],
      ];
      for (const [f, v] of seo) {
        if (canWrite(f, product[f]) && v?.trim()) writes[f] = v;
      }
    }

    // Categories picked in THIS run (M8): the search words below use their names, so a new
    // product's first words already carry its category vocabulary at no extra call.
    let pickedCategoryNames: string[] = [];
    // Categorize ONLY when the product has zero categories. Use whichever
    // language has content (Arabic-first stores may have only the Arabic).
    if (
      !plan.hasCategories &&
      plan.storeCategories.length > 0 &&
      (effName?.trim() || effNameAr?.trim())
    ) {
      const { suggestions, cached } = await AIService.suggestCategories({
        storeId,
        productName: effName || effNameAr || '',
        productDescription: effDescription || effDescriptionAr,
        existingCategories: plan.storeCategories,
      });
      spent(cached);
      const picked = suggestions.filter(s => s.confidence !== 'low').map(s => s.id);
      out.pickedCategoryIds = picked;
      pickedCategoryNames = plan.storeCategories.filter(c => picked.includes(c.id)).flatMap(nameOf);
    }

    // Search words (dialect / Franco / EN) for products.search_terms — search program P1.
    // Runs AFTER categorize (M8).
    // canWrite keeps merchant words (human, or legacy words with no provenance) untouched.
    // No Gemini key → skip quietly, exactly like the bulk sweeps.
    if (
      canWrite('searchTerms', product.searchTerms) &&
      config.googleAiKey &&
      (effName?.trim() || effNameAr?.trim())
    ) {
      const terms = await generateProductSearchTerms(
        {
          storeId,
          storeName: plan.storeNameAr || plan.storeName || '',
          product: {
            name: effName ?? '',
            nameAr: effNameAr,
            description: effDescription,
            descriptionAr: effDescriptionAr,
          },
          categoryNames: plan.hasCategories ? plan.categoryNames : pickedCategoryNames,
        },
        config.googleAiKey,
        process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'
      );
      spent(false); // the generator never caches: every return is a paid call
      if (terms) writes.searchTerms = terms;
    }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'AI_QUOTA_EXCEEDED') {
      // A provider 429 (rethrowAsAppError). Not swallowed: warn with a running count, and
      // tell the caller to back off (the sweep sleeps a full minute window, review I4).
      out.rateLimited = true;
      rateLimitedTotal++;
      logger.warn(
        { storeId, productId, rateLimitedTotal },
        '[ai-autofill] provider rate limit (429), backing off'
      );
    } else if (isAiQuotaCapError(err)) {
      out.capped = true;
      logger.info({ storeId, productId }, '[ai-autofill] quota cap reached, deferring');
    } else {
      logger.warn({ err, storeId, productId }, '[ai-autofill] fill failed');
    }
  }
  return out;
}

type GuardedOpts = {
  extraData?: Record<string, unknown>;
  extra?: (fresh: { categoryCount: number }) => Promise<void>;
  reindexReason?: string;
};

/** The guarded write on Postgres: row lock, fresh re-read, per-field compare-and-set (unchanged). */
async function guardedAiWriteOnPg(
  storeId: string,
  productId: string,
  baseline: Record<string, string | null | undefined>,
  writes: Record<string, string | null>,
  opts: GuardedOpts
): Promise<{ written: string[]; stale: string[] }> {
  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    // Inside a caller's transaction, join it (its atomicity); otherwise open a short one.
    hasTenantContext() ? fn() : runInTenantContext(storeId, fn);
  return run(async () => {
    // Row lock: a merchant save that starts after this waits for our COMMIT, and one that
    // committed before it is in the re-read below. store_id keeps the raw query tenant-keyed.
    await prisma.$queryRaw`SELECT id FROM products WHERE id = ${productId} AND store_id = ${storeId} FOR UPDATE`;
    const fresh = await (
      await storeDb(storeId)
    ).product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: { categories: { select: { categoryId: true } } },
    });
    if (!fresh) return { written: [], stale: Object.keys(writes) };
    const row = fresh as unknown as Record<string, unknown>;
    const freshSources = (fresh.aiFieldSources as AiFieldSources) ?? {};
    const nextSources: AiFieldSources = { ...freshSources };
    const data: Record<string, string | null> = {};
    const stale: string[] = [];
    for (const [field, value] of Object.entries(writes)) {
      const changed = ((row[field] as string | null) ?? '') !== (baseline[field] ?? '');
      if (freshSources[field] === 'human' || changed) {
        stale.push(field);
        continue;
      }
      data[field] = value;
      nextSources[field] = 'ai';
    }
    if (stale.length > 0) {
      logger.info(
        { storeId, productId, fields: stale },
        '[ai-autofill] fields changed since the read; not overwritten'
      );
    }
    const written = Object.keys(data);
    if (written.length > 0) {
      await (
        await storeWriter(storeId)
      ).product.update({
        where: { id: productId, storeId },
        data: { ...data, ...(opts.extraData ?? {}), aiFieldSources: nextSources },
      });
    }
    if (opts.extra) await opts.extra({ categoryCount: fresh.categories.length });
    return { written, stale };
  });
}

/**
 * The same guarded write for a store on its Durable Object (Ruling CF-JOBS-4): ONE in-DO procedure (`guardedAiWrite`,
 * packages/repo/src/rpc/writes.ts) re-reads the row, compares each field with the value the generation read, skips a
 * 'human'-owned field and writes the rest with the 'ai' stamps, atomically. `extra` runs after it, on the category count the
 * procedure saw (its own write is idempotent: `skipDuplicates`).
 */
async function guardedAiWriteOnDo(
  storeId: string,
  productId: string,
  baseline: Record<string, string | null | undefined>,
  writes: Record<string, string | null>,
  opts: GuardedOpts
): Promise<{ written: string[]; stale: string[] }> {
  const extraKeys = Object.keys(opts.extraData ?? {});
  if (extraKeys.some(k => k !== 'aiBalanceBackup'))
    throw new Error(`guardedAiWrite: extraData ${extraKeys.join(',')} is not supported on the DO`);
  const w = await storeWriter(storeId);
  const [r] = (await w.$transaction([
    w.$proc('guardedAiWrite', {
      productId,
      baseline: Object.fromEntries(Object.entries(baseline).map(([k, v]) => [k, v ?? null])),
      writes,
      extra: opts.extraData ?? {},
    }),
  ] as never)) as unknown as [
    { found: boolean; written: string[]; stale: string[]; categoryCount: number },
  ];
  if (!r.found) return { written: [], stale: Object.keys(writes) };
  if (r.stale.length > 0)
    logger.info(
      { storeId, productId, fields: r.stale },
      '[ai-autofill] fields changed since the read; not overwritten'
    );
  if (opts.extra) await opts.extra({ categoryCount: r.categoryCount });
  return { written: r.written, stale: r.stale };
}

/**
 * The one guarded writer for AI content (review I1, every AI field). In ONE short transaction:
 * lock the product row, re-read it, and write a field only when its stored value still equals
 * the value the generation read AND its owner has not become 'human' since. The provenance map
 * is rebuilt from the FRESH map (a concurrent 'human' stamp on any other field is kept).
 * `extra` runs inside the same transaction, after the write, with the fresh row.
 * When a written field feeds the search embedding (name, nameAr, description, descriptionAr, searchTerms), the
 * indexer is asked to look at the store (Task 11). The event is sent only after the writes commit:
 * the request's COMMIT, the caller's `runInTenantContext` COMMIT when this joined one (review M7,
 * `requestStoreReindex`), or this function's own short transaction, which has returned by then.
 * `reindexReason` labels that event (default 'ai-autofill').
 */
export async function writeAiFieldsGuarded(
  storeId: string,
  productId: string,
  baseline: Record<string, string | null | undefined>,
  writes: Record<string, string | null>,
  opts: GuardedOpts = {}
): Promise<{ written: string[]; stale: string[] }> {
  const repo = await storeRepo(storeId);
  const result =
    repo.backend === 'do'
      ? await guardedAiWriteOnDo(storeId, productId, baseline, writes, opts)
      : await guardedAiWriteOnPg(storeId, productId, baseline, writes, opts);
  if (touchesEmbedDoc(result.written))
    await requestStoreReindex(storeId, opts.reindexReason ?? 'ai-autofill');
  return result;
}

/** Phase 3 — WRITE (short transaction, guarded per field). Idempotent: a retry re-checks. */
export async function applyFill(plan: FillPlan, gen: FillGeneration): Promise<{ filled: number }> {
  const { storeId, productId } = plan;
  const { written } = await writeAiFieldsGuarded(storeId, productId, plan.values, gen.writes, {
    extra: async ({ categoryCount }) => {
      // Only a product that STILL has no category gets the AI's picks.
      if (gen.pickedCategoryIds.length === 0 || categoryCount > 0) return;
      const w = await storeWriter(storeId);
      await withSavepoint(() =>
        w.productCategory.createMany({
          data: gen.pickedCategoryIds.map(categoryId => ({ productId, categoryId })),
          skipDuplicates: true,
        })
      );
    },
  });
  return { filled: written.length };
}

/**
 * The single fill core shared by the event handler, the sweep and the hand-back route:
 * read → generate → guarded write. Call it OUTSIDE a transaction (a store scope or none), so no
 * transaction is held across the AI calls (review I2). NEVER overwrites a 'human' field, nor a
 * field that changed while the AI was generating (review I1).
 */
export async function fillProductFields(
  storeId: string,
  productId: string,
  opts: FillOpts
): Promise<FillResult> {
  const plan = await readFillPlan(storeId, productId, opts);
  if (!plan) return { filled: 0, skipped: true, calls: 0, rateLimited: false, capped: false };
  const gen = await generateFill(plan);
  const { filled } = await applyFill(plan, gen);
  return {
    filled,
    skipped: false,
    calls: gen.calls,
    rateLimited: gen.rateLimited,
    capped: gen.capped,
  };
}

/** Read the per-store aiAutopilot toggle (default ON when unset). */
export async function isAutopilotEnabled(storeId: string): Promise<boolean> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { theme: true },
    })
  );
  const theme = (store?.theme as Record<string, unknown>) ?? {};
  // ON by default; the master AI switch overrides it.
  return theme.aiAutopilot !== false && (await isStoreAiEnabled(storeId));
}

const STALE_TTL_DAYS = parseInt(process.env.AI_AUTOFILL_STALE_TTL_DAYS ?? '30', 10);

// -----------------------------------------------------------------------
// Language balancer (Arabic-authoritative, language-detection-based)
//
// For each pair (en, ar) where `en` should hold English/Latin and `ar`
// should hold Arabic — we use `containsArabic()` to detect what is
// actually in each slot and move/translate as needed.
//
// Algorithm per pair:
//   arabicText  = arHasAr ? ar : (enHasAr ? en : null)
//   englishText = (en && !enHasAr) ? en : ((ar && !arHasAr) ? ar : null)
//   if (!arabicText && !englishText) → skip (nothing to work with)
//   if (arabicText) {                 // Arabic is authoritative
//     newAr = arabicText
//     newEn = englishText ?? translate(arabicText, ar→en)
//   } else {                          // only English exists
//     newEn = englishText
//     newAr = translate(englishText, en→ar)
//   }
//   no-op guard: if newEn===en && newAr===ar → skip (unless opts.force)
//
// This correctly handles: both-Arabic, both-English, swapped slots,
// one-empty, and already-correct (idempotent). force=true re-translates
// even when both slots are already correct.
//
// A revert snapshot of ALL FOUR original fields + aiFieldSources is
// stored in `aiBalanceBackup` on the FIRST balance only — never overwritten
// so the true originals are always recoverable.
// -----------------------------------------------------------------------

interface BalanceBackup {
  name?: string | null;
  nameAr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
  aiFieldSources?: AiFieldSources;
}

/**
 * Balance BOTH the name and description field pairs of a single product
 * using language detection (Arabic-authoritative).
 *
 * Pairs handled independently:
 *   - name / nameAr  (kind: 'product-name')
 *   - description / descriptionAr  (kind: 'product-description')
 *
 * Snapshots ALL four original values + aiFieldSources for revert on the
 * very first balance so the true originals are never lost.
 * Returns `{ balanced: false }` when no pair needed changes.
 */
export async function balanceProductLanguages(
  storeId: string,
  productId: string,
  opts: { force?: boolean } = {}
): Promise<{
  balanced: boolean;
  changed: { name?: boolean; description?: boolean };
  sides: { name?: 'en' | 'ar'; description?: 'en' | 'ar' };
  /** provider calls made (cache hits excluded): the sweep paces on it (review I4) */
  calls: number;
}> {
  let calls = 0;
  const product = await (
    await storeDb(storeId)
  ).product.findFirst({
    where: { id: productId, storeId, deletedAt: null },
    select: {
      name: true,
      nameAr: true,
      description: true,
      descriptionAr: true,
      aiFieldSources: true,
      aiBalanceBackup: true,
    },
  });
  if (!product) return { balanced: false, changed: {}, sides: {}, calls };

  const sources = (product.aiFieldSources as AiFieldSources) ?? {};
  const existingBackup = (product.aiBalanceBackup ?? {}) as BalanceBackup;

  // Backup is considered present if ANY of the four content fields OR
  // aiFieldSources is already stored — guards ALL four original values.
  const hasBackup =
    existingBackup.name !== undefined ||
    existingBackup.nameAr !== undefined ||
    existingBackup.description !== undefined ||
    existingBackup.descriptionAr !== undefined ||
    existingBackup.aiFieldSources !== undefined;

  // Snapshot ALL four fields + sources on the FIRST balance only.
  const backup: BalanceBackup = hasBackup
    ? existingBackup
    : {
        name: product.name,
        nameAr: product.nameAr,
        description: product.description,
        descriptionAr: product.descriptionAr,
        aiFieldSources: sources,
      };

  const writes: Partial<Record<string, string | null>> = {};
  const sides: { name?: 'en' | 'ar'; description?: 'en' | 'ar' } = {};
  const changed: { name?: boolean; description?: boolean } = {};

  // ── Language-aware pair balancer ──────────────────────────────────────
  //
  // Returns true if anything was written.
  async function balancePairByLanguage(
    enVal: string | null | undefined, // the EN-slot value (product.name / product.description)
    arVal: string | null | undefined, // the AR-slot value (product.nameAr / product.descriptionAr)
    enField: string, // 'name' or 'description'
    arField: string, // 'nameAr' or 'descriptionAr'
    kind: 'product-name' | 'product-description'
  ): Promise<boolean> {
    const en = enVal?.trim() || null;
    const ar = arVal?.trim() || null;

    const enHasAr = containsArabic(en);
    const arHasAr = containsArabic(ar);

    // Locate the actual Arabic content and English content regardless of which slot they're in
    const arabicText: string | null = arHasAr ? ar! : enHasAr ? en! : null;
    const englishText: string | null = en && !enHasAr ? en : ar && !arHasAr ? ar! : null;

    if (!arabicText && !englishText) return false; // nothing to work with

    // #1572: a field stamped 'human' was explicitly set (or explicitly
    // cleared — stampHumanEdits stamps a clear too) by the merchant and
    // must never be silently re-filled by the daily sweep (force:false).
    // Checked BEFORE calling AIService.translate, not only at the write
    // step below — otherwise a human-cleared field still burns Gemini
    // quota on every sweep even though its translation is discarded.
    const humanEn = sources[enField] === 'human' && !opts.force;
    const humanAr = sources[arField] === 'human' && !opts.force;

    // Compute target values
    let newEn: string | null;
    let newAr: string | null;

    if (arabicText) {
      // Arabic is authoritative
      newAr = arabicText;
      if ((englishText && !opts.force) || humanEn) {
        // English already present and no force → keep it (no translation
        // needed). Also keep it as-is when the merchant explicitly owns
        // (or explicitly cleared) the English slot — that is not a gap
        // for AI to fill.
        newEn = englishText ?? (enVal?.trim() || null);
      } else {
        // Either English is missing, OR force:true requests a fresh translation
        const { translation, cached } = await AIService.translate({
          storeId,
          text: arabicText,
          from: 'ar',
          to: 'en',
          kind,
        });
        if (!cached) calls++;
        if (!translation?.trim()) return false;
        newEn = translation;
      }
    } else if (humanAr) {
      // Only English exists, but the Arabic slot is merchant-owned (or an
      // explicit clear) — same reasoning as humanEn above, mirrored.
      newEn = englishText!;
      newAr = arVal?.trim() || null;
    } else {
      // Only English exists
      newEn = englishText!;
      const { translation, cached } = await AIService.translate({
        storeId,
        text: englishText!,
        from: 'en',
        to: 'ar',
        kind,
      });
      if (!cached) calls++;
      if (!translation?.trim()) return false;
      newAr = translation;
    }

    // No-op guard: if both targets match what's already stored, skip unless force
    const enUnchanged = (newEn ?? '') === (enVal ?? '');
    const arUnchanged = (newAr ?? '') === (arVal ?? '');
    if (!opts.force && enUnchanged && arUnchanged) return false;

    // Write only the fields that actually changed (or all when force:true).
    // The `!human*` checks are a second guard on top of the branch logic
    // above — belt-and-suspenders against ever stamping a human-owned slot
    // 'ai' or overwriting it, even if a future edit adds another code path
    // into `newEn`/`newAr`.
    if ((!enUnchanged || opts.force) && !humanEn) {
      writes[enField] = newEn ?? null;
      // Mark the translation direction hint
      if (arabicText) sides[enField === 'name' ? 'name' : 'description'] = 'ar';
    }
    if ((!arUnchanged || opts.force) && !humanAr) {
      writes[arField] = newAr ?? null;
      if (!arabicText) sides[enField === 'name' ? 'name' : 'description'] = 'en';
    }

    return true;
  }

  // ── Pair 1: name / nameAr ─────────────────────────────────────────────
  const nameChanged = await balancePairByLanguage(
    product.name,
    product.nameAr,
    'name',
    'nameAr',
    'product-name'
  );
  if (nameChanged) changed.name = true;

  // ── Pair 2: description / descriptionAr ───────────────────────────────
  const descChanged = await balancePairByLanguage(
    product.description,
    product.descriptionAr,
    'description',
    'descriptionAr',
    'product-description'
  );
  if (descChanged) changed.description = true;

  const anyChanged = Object.keys(writes).length > 0;
  if (!anyChanged) return { balanced: false, changed, sides, calls };

  // Guarded write (review I1, same class as the fill): a field the merchant edited or stamped
  // 'human' while the translation was in flight is left alone. The guarded writer stamps 'ai'
  // on exactly the fields it writes, on the FRESH provenance map.
  const { written } = await writeAiFieldsGuarded(
    storeId,
    productId,
    {
      name: product.name,
      nameAr: product.nameAr,
      description: product.description,
      descriptionAr: product.descriptionAr,
    },
    writes as Record<string, string | null>,
    { extraData: { aiBalanceBackup: backup as object }, reindexReason: 'ai-balance' }
  );
  if (written.length === 0) return { balanced: false, changed: {}, sides: {}, calls };
  const wrote = (a: string, b: string) => written.includes(a) || written.includes(b);
  const finalChanged = {
    ...(changed.name && wrote('name', 'nameAr') ? { name: true } : {}),
    ...(changed.description && wrote('description', 'descriptionAr') ? { description: true } : {}),
  };
  const finalSides = {
    ...(finalChanged.name && sides.name ? { name: sides.name } : {}),
    ...(finalChanged.description && sides.description ? { description: sides.description } : {}),
  };

  logger.info(
    { storeId, productId, changed: finalChanged, sides: finalSides },
    '[ai-balance] language balance applied'
  );
  return { balanced: true, changed: finalChanged, sides: finalSides, calls };
}

/**
 * Back-compat alias — callers that imported `balanceProductDescription`
 * continue to work. Forwards to the new language-aware function and maps its
 * return shape back to the old `{ balanced, side }` shape (description side).
 */
export async function balanceProductDescription(
  storeId: string,
  productId: string,
  opts: { force?: boolean } = {}
): Promise<{ balanced: boolean; side: 'en' | 'ar' | null }> {
  const result = await balanceProductLanguages(storeId, productId, opts);
  return { balanced: result.balanced, side: result.sides.description ?? null };
}

/**
 * Revert a product's name and description fields to the snapshot saved
 * before the last balance operation. Clears the backup afterwards. Returns
 * `{ reverted: false }` when no backup exists.
 */
export async function revertProductBalance(
  storeId: string,
  productId: string
): Promise<{ reverted: boolean }> {
  const product = await (
    await storeDb(storeId)
  ).product.findFirst({
    where: { id: productId, storeId, deletedAt: null },
    select: { aiBalanceBackup: true },
  });
  if (!product) return { reverted: false };

  const backup = (product.aiBalanceBackup ?? {}) as BalanceBackup;
  if (
    backup.name === undefined &&
    backup.nameAr === undefined &&
    backup.description === undefined &&
    backup.descriptionAr === undefined &&
    backup.aiFieldSources === undefined
  ) {
    return { reverted: false };
  }

  await (
    await storeWriter(storeId)
  ).product.update({
    where: { id: productId, storeId },
    data: {
      // `name` is non-nullable, so ?? undefined (no-op when the backup happens to
      // be empty-string) is safe. `nameAr` IS nullable: a product whose nameAr
      // was originally null and got filled by balance must revert back to null —
      // ?? null clears it (?? undefined would leave the balanced value in place).
      name: backup.name ?? undefined,
      nameAr: backup.nameAr ?? null,
      description: backup.description ?? null,
      descriptionAr: backup.descriptionAr ?? null,
      aiFieldSources: (backup.aiFieldSources ?? {}) as object,
      aiBalanceBackup: {},
    },
  });

  await requestStoreReindex(storeId, 'ai-balance-revert');
  logger.info({ storeId, productId }, '[ai-balance] language balance reverted');
  return { reverted: true };
}
const SWEEP_THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS ?? '2500', 10);
const sweepSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/**
 * After a provider 429 the sweep waits one full per-minute rate window before the next product
 * (review I4). The throttle alone should keep 429s away; this stops a burst from hammering.
 */
export const RATE_LIMIT_BACKOFF_MS = 60_000;
/**
 * Consecutive provider 429s after which the sweep stops THIS store for this run (review N2).
 * When Google's daily quota is gone every key is benched and each call fails instantly, so an
 * unbounded backoff would idle a minute per remaining product (~16 h for 1,000 products).
 */
export const MAX_CONSECUTIVE_RATE_LIMITS = 3;

export interface SweepStoreResult {
  products: number;
  filled: number;
  calls: number;
  rateLimited: number;
  capped: boolean;
  /** stopped after MAX_CONSECUTIVE_RATE_LIMITS 429s in a row (review N2) */
  rateLimitStopped: boolean;
}

interface SweepDeps {
  fill?: typeof fillProductFields;
  balance?: (
    storeId: string,
    productId: string,
    opts: { force?: boolean }
  ) => Promise<{ balanced: boolean; calls?: number }>;
  sleep?: (ms: number) => Promise<void>;
  throttleMs?: number;
}

/**
 * Sweep one store: fill gaps on every active product, refresh ai text fields
 * whose product hasn't changed in STALE_TTL_DAYS, and (caller handles FBT
 * recompute first). No-op if autopilot is off. Run it under the store's scope
 * (`sweepAutofillStore`, review I3).
 *
 * Pacing (review I4, sleep-after-success): after each product, sleep
 * AI_BULK_THROTTLE_MS × the provider calls it ACTUALLY made (cache hits and
 * skipped products sleep nothing). A provider 429 is logged at warn with a
 * running count and backs off RATE_LIMIT_BACKOFF_MS; a quota cap stops this
 * store (terminal until the window resets). `deps` is for tests.
 */
export async function sweepStore(storeId: string, deps: SweepDeps = {}): Promise<SweepStoreResult> {
  const fill = deps.fill ?? fillProductFields;
  const balance = deps.balance ?? balanceProductLanguages;
  const sleep = deps.sleep ?? sweepSleep;
  const throttleMs = deps.throttleMs ?? SWEEP_THROTTLE_MS;
  const out: SweepStoreResult = {
    products: 0,
    filled: 0,
    calls: 0,
    rateLimited: 0,
    capped: false,
    rateLimitStopped: false,
  };
  if (!(await isAutopilotEnabled(storeId))) return out;

  const products = await (
    await storeDb(storeId)
  ).product.findMany({
    where: { storeId, status: 'active', deletedAt: null },
    select: { id: true, updatedAt: true },
  });
  out.products = products.length;

  let consecutive429 = 0;
  /** Returns true when the store must stop for this run. */
  const backOff = async (productId: string): Promise<boolean> => {
    out.rateLimited++;
    consecutive429++;
    if (consecutive429 >= MAX_CONSECUTIVE_RATE_LIMITS) {
      out.rateLimitStopped = true;
      logger.warn(
        { storeId, productId, rateLimited: out.rateLimited, consecutive: consecutive429 },
        '[ai-autofill-sweep] provider rate limit (429) persists: stopping this store for this run'
      );
      return true;
    }
    logger.warn(
      { storeId, productId, rateLimited: out.rateLimited },
      '[ai-autofill-sweep] provider rate limit (429): backing off one minute window'
    );
    await sleep(RATE_LIMIT_BACKOFF_MS);
    return false;
  };

  const staleBefore = new Date(Date.now() - STALE_TTL_DAYS * 24 * 60 * 60 * 1000);
  for (const p of products) {
    const refreshStale = p.updatedAt < staleBefore;
    const res = await fill(storeId, p.id, { op: 'sweep', refreshStale });
    out.filled += res.filled;
    out.calls += res.calls;
    if (res.calls > 0) await sleep(throttleMs * res.calls);
    if (res.capped) {
      out.capped = true;
      logger.info({ storeId, productId: p.id }, '[ai-autofill-sweep] quota cap: store stopped');
      break;
    }
    if (res.rateLimited) {
      if (await backOff(p.id)) break;
      continue;
    }

    // Autopilot: balance names + descriptions after filling so the daily sweep
    // keeps both languages in sync. force:false avoids churn on already-
    // balanced pairs. The revert backup ensures the merchant can undo.
    try {
      const bal = await balance(storeId, p.id, { force: false });
      const balCalls = bal.calls ?? 0;
      out.calls += balCalls;
      if (bal.balanced) out.filled += 1;
      consecutive429 = 0; // a product got through: the 429s were not persistent
      if (balCalls > 0) await sleep(throttleMs * balCalls);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'AI_QUOTA_EXCEEDED') {
        if (await backOff(p.id)) break;
        continue;
      }
      if (isAiQuotaCapError(err)) {
        out.capped = true;
        break;
      }
      logger.warn({ err, storeId, productId: p.id }, '[ai-balance] sweep balance failed, skipping');
    }
  }
  return out;
}

/**
 * Enqueue the store-wide AI recommendations sweep for a newly created
 * product, so cross-sell suggestions exist without waiting for the next
 * manual bulk sweep. Coalesces: skip if one is already queued/running for
 * this store — the sweep is store-wide and smart-skips, so the first job
 * already covers every new product; don't spawn N near-identical jobs.
 *
 * Called from `ProductService.create()` — the ONE true creation site —
 * rather than gated on the `op === 'create'` branch of the debounced
 * `product.upserted` handler (`ai-autofill-product.ts`). That handler's
 * Inngest function debounces on `productId` for 10s, and Inngest debounce
 * delivers only the LAST event in the window: a create followed by a quick
 * edit inside 10s coalesced into one `op: 'update'` delivery, silently
 * skipping the kick every time (#1937).
 *
 * POST-COMMIT (issues 2108 / 2214 / 2215). Inside a request the create runs
 * in the request's single tenant transaction, which commits only after the
 * handler returns. Doing the job insert + `inngest.send` inline there
 * published a jobId for an UNCOMMITTED row (the consumer's first step
 * P2025s on it; a rolled-back create dead-lettered a P1 for a product that
 * never existed), held the Neon connection across the Inngest round-trip,
 * and — worst — a failing `bulkAiJob` query aborted the request transaction
 * while the swallowing catch below let the handler answer 201 for a product
 * whose COMMIT then silently rolled back. So the kick is queued with
 * `deferAfterTenantCommit`: it runs after COMMIT in a fresh tenant
 * transaction (a rolled-back create drops it), and outside a request it runs
 * inline as before. The inline path can still sit inside a caller's ambient
 * transaction (an Inngest/MCP `runInTenantContext`), so the two queries are
 * savepointed: a failure there rolls back to the savepoint only, which is
 * what makes "non-fatal" below actually true.
 */
export async function enqueueRecommendationsSweepForNewProduct(
  storeId: string,
  productId: string
): Promise<void> {
  await deferAfterTenantCommit('ai-autofill.recommendations-kick', () =>
    enqueueRecommendationsSweepNow(storeId, productId)
  );
}

async function enqueueRecommendationsSweepNow(storeId: string, productId: string): Promise<void> {
  try {
    const jobId = await withSavepoint(async () => {
      const existing = await (
        await storeDb(storeId)
      ).bulkAiJob.findFirst({
        where: { storeId, kind: 'recommendations', status: { in: ['queued', 'running'] } },
        select: { id: true },
      });
      if (existing) {
        logger.info(
          { storeId, productId, jobId: existing.id },
          '[ai-autofill] recommendations sweep already pending, skipping'
        );
        return null;
      }
      const job = await (
        await storeWriter(storeId)
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: null, // system-initiated — no authenticated user context
          kind: 'recommendations',
        },
        select: { id: true },
      });
      return job.id;
    });
    if (!jobId) return;

    try {
      await inngest.send({
        name: 'bulk-ai/recommendations-requested',
        data: { jobId, storeId, force: false },
      });
    } catch (sendErr) {
      // Queue-then-send fails fast (Ruling JOBS-ORPHAN-1): nothing will start this row, so fail it
      // rather than leave an orphan `queued` one, then fall into the non-fatal catch below.
      await markJobFailedOnEnqueueError(storeId, jobId, sendErr);
      throw sendErr;
    }

    logger.info(
      { storeId, productId, jobId },
      '[ai-autofill] recommendations sweep enqueued for new product'
    );
  } catch (err) {
    // Non-fatal: this runs after the product's COMMIT (or, inline, behind a
    // savepoint), so the product exists either way; recommendations will be
    // generated on the next manual bulk sweep.
    logger.warn(
      { err, storeId, productId },
      '[ai-autofill] failed to enqueue recommendations sweep'
    );
  }
}
