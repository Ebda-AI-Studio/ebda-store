/**
 * Extract ONE stored file into staged items. Runs inside the store's scope (`runInStoreScope`), one
 * file per durable job step. Idempotent: a retried step re-enters a `processing` file and replaces
 * that file's items, so nothing is duplicated and nothing is left orphaned.
 *
 * Logging: ids and counts only. Never file bytes, prompt, model reply, product text or file names.
 */
import { prisma } from '@ebda/database';
import { catalogueRawPageSchema, stageCatalogueItems, normalizeArabicSearch } from '@ebda/shared';
import { AppError } from '../../middleware/error-handler';
import { isAiQuotaCapError } from '../ai-quota';
import logger from '../logger';
import { StorageService } from '../../services/storage.service';
import { chargeVerdict, pageAllowance } from './page-ledger';
import { sniffCatalogueFile } from './sniff';
import { getCatalogueExtractor } from './gemini-vision-extractor';
import type { CatalogueExtractor } from './extractor';

export interface ProcessFileResult {
  outcome: 'done' | 'failed' | 'skipped_quota' | 'cancelled' | 'skipped';
  calledModel: boolean;
  /** Pause before the next file (provider asked us to slow down). */
  retryAfterMs?: number;
  /** The platform/store AI cap is hit: do not try the remaining files. */
  stopAll?: boolean;
}

const keyPrefix = (storeId: string, jobId: string) => `stores/${storeId}/catalogimport-${jobId}/`;

export async function processFile(
  storeId: string,
  jobId: string,
  fileId: string,
  categoryNames: string[],
  extractor: CatalogueExtractor = getCatalogueExtractor()
): Promise<ProcessFileResult> {
  const job = await prisma.catalogImportJob.findFirst({
    where: { id: jobId, storeId },
    select: { status: true },
  });
  if (!job || job.status === 'cancelled') return { outcome: 'cancelled', calledModel: false };

  const file = await prisma.catalogImportFile.findFirst({
    where: { id: fileId, jobId, storeId, status: { in: ['stored', 'processing'] } },
  });
  if (!file) return { outcome: 'skipped', calledModel: false };

  const mark = (data: Record<string, unknown>) =>
    prisma.catalogImportFile.updateMany({ where: { id: fileId, storeId }, data });

  // Plan allowance first (a file already charged is free to retry).
  if (!file.quotaCounted) {
    const verdict = chargeVerdict(await pageAllowance(storeId), file.pageCount);
    if (verdict !== 'ok') {
      await mark({ status: 'skipped_quota', errorCode: verdict, finishedAt: new Date() });
      return { outcome: 'skipped_quota', calledModel: false };
    }
  }

  await mark({ status: 'processing', attempts: { increment: 1 }, errorCode: null });

  if (!file.storageKey.startsWith(keyPrefix(storeId, jobId))) {
    await mark({ status: 'failed', errorCode: 'BAD_STORAGE_KEY', finishedAt: new Date() });
    return { outcome: 'failed', calledModel: false };
  }

  let bytes: Buffer;
  let mime: string;
  try {
    const got = await StorageService.getPrivate(file.storageKey);
    const sniffed = sniffCatalogueFile(got.body);
    if (!sniffed) throw new Error('unsupported');
    bytes = got.body;
    mime = sniffed.mime;
  } catch {
    await mark({ status: 'failed', errorCode: 'FILE_UNREADABLE', finishedAt: new Date() });
    return { outcome: 'failed', calledModel: false };
  }

  let reply;
  try {
    reply = await extractor.extract({
      storeId,
      bytes,
      mime,
      pageCount: file.pageCount,
      categories: categoryNames,
    });
  } catch (err) {
    if (isAiQuotaCapError(err)) {
      const code = (err as AppError).code;
      await mark({ status: 'skipped_quota', errorCode: code, finishedAt: new Date() });
      return { outcome: 'skipped_quota', calledModel: false, stopAll: true };
    }
    const status = (err as AppError).statusCode;
    // A 429 is NOT retried inline: the file is marked, the job pauses, the merchant can retry it.
    const code = status === 429 ? 'AI_RATE_LIMITED' : (err as AppError).code || 'EXTRACTION_FAILED';
    await mark({ status: 'failed', errorCode: String(code).slice(0, 60), finishedAt: new Date() });
    logger.warn({ jobId, fileId, code }, '[catalog-import] extraction failed');
    return {
      outcome: 'failed',
      calledModel: false,
      retryAfterMs: status === 429 ? 60_000 : undefined,
    };
  }

  // The reply came back: the page is charged now, whatever the parse says.
  await mark({
    quotaCounted: true,
    startedAt: file.startedAt ?? new Date(),
    inputTokens: reply.inputTokens,
    outputTokens: reply.outputTokens,
    model: reply.model,
  });

  const parsed = catalogueRawPageSchema.safeParse(reply.raw);
  if (!parsed.success) {
    await mark({ status: 'failed', errorCode: 'BAD_RESPONSE', finishedAt: new Date() });
    return { outcome: 'failed', calledModel: true };
  }

  const categories = await prisma.category.findMany({
    where: { storeId, deletedAt: null },
    select: { id: true, name: true, nameAr: true },
    take: 500,
  });
  const staged = stageCatalogueItems(parsed.data, { storeCategories: categories });

  // Duplicates against the live catalogue: same SKU, or the same folded name. Flagged, never merged.
  const skus = staged.map(s => s.sku).filter((s): s is string => !!s);
  const names = staged.flatMap(s => [s.name, s.nameAr]).filter((n): n is string => !!n);
  const existing =
    skus.length || names.length
      ? await prisma.product.findMany({
          where: {
            storeId,
            deletedAt: null,
            OR: [
              ...(skus.length ? [{ sku: { in: skus } }] : []),
              ...(names.length ? [{ name: { in: names } }, { nameAr: { in: names } }] : []),
            ],
          },
          select: { sku: true, name: true, nameAr: true },
          take: 1000,
        })
      : [];
  const existingSkus = new Set(existing.map(p => p.sku).filter(Boolean));
  const existingNames = new Set(
    existing
      .flatMap(p => [p.name, p.nameAr])
      .filter(Boolean)
      .map(n => normalizeArabicSearch(n as string))
  );
  for (const s of staged) {
    if (s.sku && existingSkus.has(s.sku)) s.flags.push('duplicate_sku');
    const folded = [s.name, s.nameAr].filter(Boolean).map(n => normalizeArabicSearch(n as string));
    if (folded.some(n => existingNames.has(n))) s.flags.push('duplicate_exact');
  }

  await prisma.catalogImportItem.deleteMany({ where: { fileId, storeId } });
  if (staged.length) {
    await prisma.catalogImportItem.createMany({
      data: staged.map(s => ({
        jobId,
        fileId,
        storeId,
        name: s.name,
        nameAr: s.nameAr,
        description: s.description,
        descriptionAr: s.descriptionAr,
        priceMinor: s.priceMinor,
        compareAtMinor: s.compareAtMinor,
        priceRaw: s.priceRaw,
        sku: s.sku,
        categoryName: s.categoryName,
        categoryId: s.categoryId,
        tags: s.tags,
        variants: s.variants as never,
        confidence: s.confidence,
        flags: s.flags,
        sourceText: s.sourceText,
      })),
    });
  }
  await mark({ status: 'done', itemsFound: staged.length, finishedAt: new Date() });
  logger.info({ jobId, fileId, items: staged.length }, '[catalog-import] file extracted');
  return { outcome: 'done', calledModel: true };
}

/** Recompute the job's progress counters from the rows (no drift). */
export async function refreshJobCounters(storeId: string, jobId: string) {
  const [files, itemsTotal] = await Promise.all([
    prisma.catalogImportFile.groupBy({
      by: ['status'],
      where: { jobId, storeId },
      _count: { _all: true },
    }),
    prisma.catalogImportItem.count({ where: { jobId, storeId } }),
  ]);
  const n = (s: string) => files.find(f => f.status === s)?._count._all ?? 0;
  await prisma.catalogImportJob.updateMany({
    where: { id: jobId, storeId },
    data: { filesDone: n('done'), filesFailed: n('failed') + n('skipped_quota'), itemsTotal },
  });
  return { done: n('done'), failed: n('failed'), skipped: n('skipped_quota') };
}
