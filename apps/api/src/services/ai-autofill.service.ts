import { AI_AUTOFILL_FIELD_NAMES, fieldsNeedingRefresh, type AiFieldSources } from '@force/shared';
import { prisma } from '@force/database';
import { AIService } from './ai.service';
import { isAiQuotaCapError } from '../lib/ai-quota';
import logger from '../lib/logger';

/**
 * Diff incoming admin-form values against the stored values and update the
 * provenance map: any AI-writable field whose value changed becomes
 * 'human' (the override guarantee); a field cleared to empty loses its key
 * (back to "empty"). Only AI-writable fields are considered. `incoming` may
 * omit fields (PATCH semantics) — omitted = unchanged.
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
    if (String(after).trim() === '') {
      delete next[field];
    } else {
      next[field] = 'human';
    }
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
  // Stale-refresh (3-day sweep on a long-untouched product): also regenerate
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
 * The single fill core shared by the event handler and the sweep. Loads the
 * product, computes the fill set, calls the existing AIService methods (which
 * enforce quota + cache + usage recording), writes the results, and stamps
 * the filled fields 'ai'. NEVER overwrites a 'human' field (computeFillSet
 * excludes them).
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
  let fillSet = new Set(
    computeFillSet(sources, opts.op, opts.changedFields ?? [], opts.refreshStale ?? false)
  );
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

  // A field is a safe write target only if it's in the fill set AND either
  // currently empty OR explicitly ai-owned (a refresh). This is the crucial
  // guard for LEGACY/pre-feature products whose `aiFieldSources` is `{}`: such
  // a product can have real human-written content with no provenance entry, so
  // computeFillSet treats it as "empty" — without this value check the engine
  // would OVERWRITE that human content. Never write over existing content that
  // isn't ours.
  const canWrite = (field: string, currentVal: string | null | undefined): boolean =>
    fillSet.has(field) && (!currentVal?.trim() || sources[field] === 'ai');

  try {
    // EN/AR content pairs — translate in WHICHEVER direction is needed. The
    // `&& <source>?.trim()` guard means we only translate when the source
    // language actually has content, so the mutual sourcing never loops and a
    // both-empty pair is simply skipped.

    // name: AR → EN (Arabic-first merchant wrote nameAr, English empty)
    if (canWrite('name', product.name) && product.nameAr?.trim()) {
      const { translation } = await AIService.translate({
        storeId,
        text: product.nameAr,
        from: 'ar',
        to: 'en',
        kind: 'product-name',
      });
      if (translation) {
        writes.name = translation;
        stampedSources.name = 'ai';
      }
    }
    // name: EN → AR
    if (canWrite('nameAr', product.nameAr) && product.name?.trim()) {
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

    // description: AR → EN
    if (canWrite('description', product.description) && product.descriptionAr?.trim()) {
      const { translation } = await AIService.translate({
        storeId,
        text: product.descriptionAr,
        from: 'ar',
        to: 'en',
        kind: 'product-description',
      });
      if (translation) {
        writes.description = translation;
        stampedSources.description = 'ai';
      }
    }
    // description: EN → AR
    if (canWrite('descriptionAr', product.descriptionAr) && product.description?.trim()) {
      const { translation } = await AIService.translate({
        storeId,
        text: product.description,
        from: 'en',
        to: 'ar',
        kind: 'product-description',
      });
      if (translation) {
        writes.descriptionAr = translation;
        stampedSources.descriptionAr = 'ai';
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
      const { suggestion } = await AIService.suggestSeo({
        storeId,
        kind: 'product',
        storeName: store?.name ?? '',
        storeNameAr: store?.nameAr,
        entityName: effName || effNameAr || '',
        entityNameAr: effNameAr,
        entityDescription: effDescription,
        entityDescriptionAr: effDescriptionAr,
      });
      // Guard each write against an empty/whitespace value — Gemini can return
      // "" for a sparse product, and writing it would stamp the field 'ai' and
      // lock the empty value in (never re-filled until a source changes).
      if (canWrite('metaTitle', product.metaTitle) && suggestion.title?.trim()) {
        writes.metaTitle = suggestion.title;
        stampedSources.metaTitle = 'ai';
      }
      if (canWrite('metaTitleAr', product.metaTitleAr) && suggestion.titleAr?.trim()) {
        writes.metaTitleAr = suggestion.titleAr;
        stampedSources.metaTitleAr = 'ai';
      }
      if (canWrite('metaDescription', product.metaDescription) && suggestion.description?.trim()) {
        writes.metaDescription = suggestion.description;
        stampedSources.metaDescription = 'ai';
      }
      if (
        canWrite('metaDescriptionAr', product.metaDescriptionAr) &&
        suggestion.descriptionAr?.trim()
      ) {
        writes.metaDescriptionAr = suggestion.descriptionAr;
        stampedSources.metaDescriptionAr = 'ai';
      }
    }

    // Categorize ONLY when the product has zero categories. Use whichever
    // language has content (Arabic-first stores may have only the Arabic).
    if (product.categories.length === 0 && (effName?.trim() || effNameAr?.trim())) {
      const cats = await prisma.category.findMany({
        where: { storeId },
        select: { id: true, name: true, nameAr: true },
      });
      if (cats.length > 0) {
        const { suggestions } = await AIService.suggestCategories({
          storeId,
          productName: effName || effNameAr || '',
          productDescription: effDescription || effDescriptionAr,
          existingCategories: cats,
        });
        const picked = suggestions.filter(s => s.confidence !== 'low').map(s => s.id);
        if (picked.length > 0) {
          await prisma.productCategory.createMany({
            data: picked.map(categoryId => ({ productId, categoryId })),
            skipDuplicates: true,
          });
        }
      }
    }
  } catch (err) {
    if (isAiQuotaCapError(err)) {
      logger.info({ storeId, productId }, '[ai-autofill] quota cap reached, deferring');
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

/** Read the per-store aiAutopilot toggle (default ON when unset). */
export async function isAutopilotEnabled(storeId: string): Promise<boolean> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { theme: true },
  });
  const theme = (store?.theme as Record<string, unknown>) ?? {};
  return theme.aiAutopilot !== false; // default ON
}

const STALE_TTL_DAYS = parseInt(process.env.AI_AUTOFILL_STALE_TTL_DAYS ?? '30', 10);
const SWEEP_THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS ?? '2500', 10);
const sweepSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Sweep one store: fill gaps on every active product, refresh ai text fields
 * whose product hasn't changed in STALE_TTL_DAYS, and (caller handles FBT
 * recompute first). Throttled like the bulk jobs. No-op if autopilot is off.
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
