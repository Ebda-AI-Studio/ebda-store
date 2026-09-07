import { AI_AUTOFILL_FIELD_NAMES, fieldsNeedingRefresh, type AiFieldSources } from '@force/shared';
import { prisma } from '@force/database';
import { AIService } from './ai.service';
import { isAiQuotaCapError } from '../lib/ai-quota';
import { containsArabic } from '../lib/ai/description-richness';
import logger from '../lib/logger';

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
}> {
  const product = await prisma.product.findFirst({
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
  if (!product) return { balanced: false, changed: {}, sides: {} };

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
  const newSources: AiFieldSources = { ...sources };
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

    // Compute target values
    let newEn: string | null;
    let newAr: string | null;

    if (arabicText) {
      // Arabic is authoritative
      newAr = arabicText;
      if (englishText && !opts.force) {
        // English already present and no force → keep it (no translation needed)
        newEn = englishText;
      } else {
        // Either English is missing, OR force:true requests a fresh translation
        const { translation } = await AIService.translate({
          storeId,
          text: arabicText,
          from: 'ar',
          to: 'en',
          kind,
        });
        if (!translation?.trim()) return false;
        newEn = translation;
      }
    } else {
      // Only English exists
      newEn = englishText!;
      const { translation } = await AIService.translate({
        storeId,
        text: englishText!,
        from: 'en',
        to: 'ar',
        kind,
      });
      if (!translation?.trim()) return false;
      newAr = translation;
    }

    // No-op guard: if both targets match what's already stored, skip unless force
    const enUnchanged = (newEn ?? '') === (enVal ?? '');
    const arUnchanged = (newAr ?? '') === (arVal ?? '');
    if (!opts.force && enUnchanged && arUnchanged) return false;

    // Write only the fields that actually changed (or all when force:true)
    if (!enUnchanged || opts.force) {
      writes[enField] = newEn ?? null;
      newSources[enField] = 'ai';
      // Mark the translation direction hint
      if (arabicText) sides[enField === 'name' ? 'name' : 'description'] = 'ar';
    }
    if (!arUnchanged || opts.force) {
      writes[arField] = newAr ?? null;
      newSources[arField] = 'ai';
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
  if (!anyChanged) return { balanced: false, changed, sides };

  await prisma.product.update({
    where: { id: productId, storeId },
    data: {
      ...(writes as Record<string, string | null>),
      aiFieldSources: newSources,
      aiBalanceBackup: backup as object,
    },
  });

  logger.info({ storeId, productId, changed, sides }, '[ai-balance] language balance applied');
  return { balanced: true, changed, sides };
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
  const product = await prisma.product.findFirst({
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

  await prisma.product.update({
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

  logger.info({ storeId, productId }, '[ai-balance] language balance reverted');
  return { reverted: true };
}
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

    // Autopilot: balance names + descriptions after filling so the 3-day sweep
    // keeps both languages in sync. force:false avoids churn on already-
    // balanced pairs. The revert backup ensures the merchant can undo.
    try {
      const balResult = await balanceProductLanguages(storeId, p.id, { force: false });
      if (balResult.balanced) {
        filled += 1;
        await sweepSleep(SWEEP_THROTTLE_MS);
      }
    } catch (err) {
      if (isAiQuotaCapError(err)) throw err;
      logger.warn({ err, storeId, productId: p.id }, '[ai-balance] sweep balance failed, skipping');
    }
  }
  return { products: products.length, filled };
}
