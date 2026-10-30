/**
 * Catalogue import: photos / PDFs -> reviewed draft products.
 *
 * Every method takes `storeId` and puts it in every `where` (RLS is the second layer, not the first).
 * Nothing here writes `status: 'active'` except `publishItems`, the single explicit publish site
 * (pinned by tests/unit/catalog-import-no-auto-publish.test.ts).
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { prisma, runInStoreScope, withMoneyTx, Prisma } from '@ebda/database';
import { storeDb, storeMoney, storeWriter } from '../lib/repo-factory';
import {
  BLOCKING_FLAGS,
  CATALOGUE_LIMITS,
  normalizeArabicSearch,
  redactPersonalData,
  injectionMarkers,
  sanitizeCatalogueText,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { inngest } from '../lib/inngest/client';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import { CATALOGUE_EXT, displayFileName, sniffCatalogueFile } from '../lib/catalogue/sniff';
import {
  catalogImportKillSwitchOn,
  catalogueLimits,
  pageAllowance,
} from '../lib/catalogue/page-ledger';
import { StorageService } from './storage.service';
import { ProductService } from './product.service';
import { BulkService, createVariantsForProductTx, type VariantImportRow } from './bulk.service';

const RETENTION_DAYS = 30;
const STALE_QUEUED_MS = 10 * 60_000;
const STALE_PROCESSING_MS = 30 * 60_000;
const ACTIVE = ['queued', 'processing', 'creating'];
const TERMINAL = ['done', 'failed', 'cancelled'];

/** The key prefix every object of a job lives under (putPrivate strips `/` from `folder`). */
export const jobFolder = (jobId: string) => `catalogimport-${jobId}`;
export const jobKeyPrefix = (storeId: string, jobId: string) =>
  `stores/${storeId}/${jobFolder(jobId)}/`;

export interface UploadedFile {
  buffer: Buffer;
  originalName?: string;
}

// ---------------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------------

export async function createJob(
  storeId: string,
  userId: string | undefined,
  files: UploadedFile[]
) {
  if (catalogImportKillSwitchOn()) {
    throw new AppError(503, 'CATALOG_IMPORT_DISABLED', 'Catalogue import is switched off.');
  }
  const lim = catalogueLimits();
  if (files.length === 0) throw new AppError(400, 'NO_FILES', 'No files were uploaded.');
  if (files.length > lim.maxFilesPerJob) {
    throw new AppError(400, 'TOO_MANY_FILES', `At most ${lim.maxFilesPerJob} files per import.`);
  }

  await sweepStaleJobs(storeId);
  const allowance = await pageAllowance(storeId);
  if (!allowance.enabled) {
    throw new AppError(
      403,
      'FEATURE_NOT_AVAILABLE',
      'Catalogue import is not included in your plan.'
    );
  }
  const active = await (
    await storeDb(storeId)
  ).catalogImportJob.count({
    where: { storeId, status: { in: ACTIVE } },
  });
  if (active >= lim.maxActiveJobs) {
    throw new AppError(429, 'CATALOG_IMPORT_BUSY', 'Finish the imports in progress first.');
  }

  // Validate EVERYTHING before storing anything: a mixed valid + invalid request stores nothing.
  const checked: Array<{
    f: UploadedFile;
    sniffed: NonNullable<ReturnType<typeof sniffCatalogueFile>>;
    pages: number;
  }> = [];
  for (const original of files) {
    const f = original;
    const sniffed = sniffCatalogueFile(f.buffer);
    if (!sniffed) {
      throw new AppError(
        415,
        'UNSUPPORTED_FILE_TYPE',
        'Only photos (JPG, PNG, WebP, HEIC) and PDF files are supported.'
      );
    }
    const cap = sniffed.kind === 'pdf' ? lim.maxPdfBytes : lim.maxImageBytes;
    if (f.buffer.length > cap) {
      throw new AppError(413, 'FILE_TOO_LARGE', 'A file is too large.');
    }
    // The request handler only checks magic bytes and size. A PDF's real page count (and its
    // sanitising re-emit) is the job step's work (processFile): parsing untrusted PDFs, which can be
    // decompression bombs, never happens on the request path. 1 is a placeholder until then.
    const pages = 1;
    checked.push({ f, sniffed, pages });
  }
  const pagesTotal = checked.reduce((n, c) => n + c.pages, 0);

  const jobId = randomUUID();
  const stored: string[] = [];
  const rows: Array<Prisma.CatalogImportFileUncheckedCreateWithoutJobInput> = [];
  try {
    for (const c of checked) {
      const { key } = await StorageService.putPrivate(c.f.buffer, {
        storeId,
        folder: jobFolder(jobId),
        ext: CATALOGUE_EXT[c.sniffed.mime],
        contentType: c.sniffed.mime,
      });
      stored.push(key);
      rows.push({
        storeId,
        storageKey: key,
        mime: c.sniffed.mime,
        sizeBytes: c.f.buffer.length,
        sha256: createHash('sha256').update(c.f.buffer).digest('hex'),
        originalName: displayFileName(c.f.originalName),
        pageCount: c.pages,
      });
    }
    await (
      await storeWriter(storeId)
    ).catalogImportJob.create({
      data: {
        id: jobId,
        storeId,
        createdBy: userId ?? null,
        status: 'queued',
        filesTotal: rows.length,
        pagesTotal,
        expiresAt: new Date(Date.now() + RETENTION_DAYS * 86_400_000),
        files: { create: rows },
      },
    });
  } catch (err) {
    await Promise.all(stored.map(k => StorageService.deletePrivate(k).catch(() => undefined)));
    throw err;
  }

  await enqueue(storeId, jobId, 'catalog-import/started', 'ENQUEUE_FAILED');
  return { jobId };
}

/**
 * Enqueue AFTER the request transaction commits. On a throw the job is marked failed (never left
 * `queued`) and its stored originals are deleted: the merchant sees the failure on the next poll.
 */
async function enqueue(
  storeId: string,
  jobId: string,
  name: 'catalog-import/started' | 'catalog-import/create-drafts',
  failCode: string,
  extra: Record<string, unknown> = {}
) {
  await deferAfterTenantCommit(`catalog-import-enqueue:${jobId}`, async () => {
    try {
      await inngest.send({ name, data: { jobId, storeId, ...extra } } as never);
    } catch (err) {
      logger.error({ err, jobId }, '[catalog-import] enqueue failed; failing the job');
      await failJob(storeId, jobId, failCode, name === 'catalog-import/started');
    }
  });
}

export async function failJob(
  storeId: string,
  jobId: string,
  errorCode: string,
  purgeFiles = false
) {
  try {
    await runInStoreScope(storeId, async () => {
      await (
        await storeWriter(storeId)
      ).catalogImportJob.updateMany({
        where: { id: jobId, storeId, status: { notIn: ['done', 'cancelled'] } },
        data: { status: 'failed', errorCode, completedAt: new Date() },
      });
      if (purgeFiles) await deleteJobObjects(storeId, jobId);
    });
  } catch (err) {
    logger.error({ err, jobId }, '[catalog-import] could not mark job failed');
  }
}

async function deleteJobObjects(storeId: string, jobId: string) {
  const files = await (
    await storeDb(storeId)
  ).catalogImportFile.findMany({
    where: { jobId, storeId },
    select: { storageKey: true },
  });
  await Promise.all(
    files.map(f => StorageService.deletePrivate(f.storageKey).catch(() => undefined))
  );
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

/** A job stuck `queued` / `processing` is failed on read: the second net behind the fail-fast enqueue. */
export async function sweepStaleJobs(storeId: string) {
  const now = Date.now();
  await (
    await storeWriter(storeId)
  ).catalogImportJob.updateMany({
    where: { storeId, status: 'queued', updatedAt: { lt: new Date(now - STALE_QUEUED_MS) } },
    data: { status: 'failed', errorCode: 'NOT_STARTED', completedAt: new Date() },
  });
  await (
    await storeWriter(storeId)
  ).catalogImportJob.updateMany({
    where: {
      storeId,
      status: { in: ['processing', 'creating'] },
      updatedAt: { lt: new Date(now - STALE_PROCESSING_MS) },
    },
    data: { status: 'failed', errorCode: 'STUCK', completedAt: new Date() },
  });
}

/** Retention (30 days): expired jobs and their private originals are purged when the store is active. */
export async function purgeExpiredJobs(storeId: string) {
  const expired = await (
    await storeDb(storeId)
  ).catalogImportJob.findMany({
    where: { storeId, expiresAt: { lt: new Date() } },
    select: { id: true },
    take: 5,
  });
  for (const j of expired) {
    await deleteJobObjects(storeId, j.id);
    await (
      await storeWriter(storeId)
    ).catalogImportJob.deleteMany({ where: { id: j.id, storeId } });
  }
}

const JOB_SELECT = {
  id: true,
  status: true,
  errorCode: true,
  filesTotal: true,
  filesDone: true,
  filesFailed: true,
  pagesTotal: true,
  itemsTotal: true,
  draftsCreated: true,
  createdAt: true,
  completedAt: true,
  expiresAt: true,
} satisfies Prisma.CatalogImportJobSelect;

export async function listJobs(storeId: string) {
  await sweepStaleJobs(storeId);
  await purgeExpiredJobs(storeId);
  const [jobs, allowance] = await Promise.all([
    (await storeDb(storeId)).catalogImportJob.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: JOB_SELECT,
    }),
    pageAllowance(storeId),
  ]);
  return { jobs, allowance };
}

export async function getJob(storeId: string, jobId: string) {
  await sweepStaleJobs(storeId);
  const job = await (
    await storeDb(storeId)
  ).catalogImportJob.findFirst({
    where: { id: jobId, storeId },
    select: {
      ...JOB_SELECT,
      files: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          mime: true,
          originalName: true,
          pageCount: true,
          status: true,
          errorCode: true,
          itemsFound: true,
        },
      },
    },
  });
  if (!job) throw new AppError(404, 'NOT_FOUND', 'Import not found.');
  const grouped = await (
    await storeDb(storeId)
  ).catalogImportItem.groupBy({
    by: ['status'],
    where: { jobId, storeId },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  return { ...job, itemCounts: counts };
}

async function requireJob(storeId: string, jobId: string) {
  const job = await (
    await storeDb(storeId)
  ).catalogImportJob.findFirst({
    where: { id: jobId, storeId },
    select: { id: true, status: true },
  });
  if (!job) throw new AppError(404, 'NOT_FOUND', 'Import not found.');
  return job;
}

export async function cancelJob(storeId: string, jobId: string) {
  const job = await requireJob(storeId, jobId);
  if (TERMINAL.includes(job.status) || job.status === 'review') {
    throw new AppError(409, 'NOT_CANCELLABLE', 'This import has already finished.');
  }
  await (
    await storeWriter(storeId)
  ).catalogImportJob.updateMany({
    where: { id: jobId, storeId },
    data: { status: 'cancelled', completedAt: new Date() },
  });
}

export async function deleteJob(storeId: string, jobId: string) {
  await requireJob(storeId, jobId);
  await deleteJobObjects(storeId, jobId);
  await (await storeWriter(storeId)).catalogImportJob.deleteMany({ where: { id: jobId, storeId } });
}

/**
 * Retry one failed / quota-skipped file. Bounded three ways: attempts per file
 * (CATALOG_IMPORT_MAX_ATTEMPTS, from `file.attempts`), the active-jobs cap (a retry re-activates its
 * job, so it counts like a new import), and the page ledger (every attempt that reaches the model is
 * charged again in `processFile`; an attempt that fails before the model is called is free).
 */
export async function retryFile(storeId: string, jobId: string, fileId: string) {
  const lim = catalogueLimits();
  const file = await (
    await storeDb(storeId)
  ).catalogImportFile.findFirst({
    where: { id: fileId, jobId, storeId },
    select: { id: true, status: true, attempts: true, job: { select: { status: true } } },
  });
  if (!file) throw new AppError(404, 'NOT_FOUND', 'File not found.');
  if (file.status !== 'failed' && file.status !== 'skipped_quota') {
    throw new AppError(409, 'NOT_RETRYABLE', 'This file is not waiting for a retry.');
  }
  if (ACTIVE.includes(file.job.status) || file.job.status === 'cancelled') {
    throw new AppError(409, 'NOT_RETRYABLE', 'This import is still running.');
  }
  if (file.attempts >= lim.maxAttempts) {
    throw new AppError(409, 'TOO_MANY_RETRIES', 'This file was tried too many times.');
  }
  const otherActive = await (
    await storeDb(storeId)
  ).catalogImportJob.count({
    where: { storeId, status: { in: ACTIVE }, id: { not: jobId } },
  });
  if (otherActive >= lim.maxActiveJobs) {
    throw new AppError(429, 'CATALOG_IMPORT_BUSY', 'Finish the imports in progress first.');
  }
  // Atomic claim: two concurrent retries cannot both start the file.
  const claimed = await (
    await storeWriter(storeId)
  ).catalogImportFile.updateMany({
    where: { id: fileId, storeId, status: { in: ['failed', 'skipped_quota'] } },
    data: { status: 'stored', errorCode: null },
  });
  if (claimed.count !== 1)
    throw new AppError(409, 'NOT_RETRYABLE', 'This file is already retrying.');
  await (
    await storeWriter(storeId)
  ).catalogImportJob.updateMany({
    where: { id: jobId, storeId },
    data: { status: 'queued', errorCode: null, completedAt: null },
  });
  await enqueue(storeId, jobId, 'catalog-import/started', 'ENQUEUE_FAILED');
}

/** Source bytes for the review screen. Tenant-checked; the content type is re-sniffed from the bytes. */
export async function getSourceFile(storeId: string, jobId: string, fileId: string) {
  const file = await (
    await storeDb(storeId)
  ).catalogImportFile.findFirst({
    where: { id: fileId, jobId, storeId },
    select: { storageKey: true },
  });
  if (!file || !file.storageKey.startsWith(jobKeyPrefix(storeId, jobId))) {
    throw new AppError(404, 'NOT_FOUND', 'File not found.');
  }
  const { body } = await StorageService.getPrivate(file.storageKey);
  const sniffed = sniffCatalogueFile(body);
  if (!sniffed) throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Unreadable file.');
  return { body, mime: sniffed.mime, kind: sniffed.kind };
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------

const ITEM_SELECT = {
  id: true,
  fileId: true,
  status: true,
  name: true,
  nameAr: true,
  description: true,
  descriptionAr: true,
  priceMinor: true,
  compareAtMinor: true,
  sku: true,
  categoryName: true,
  categoryId: true,
  tags: true,
  variants: true,
  confidence: true,
  flags: true,
  acknowledged: true,
  sourceText: true,
  editedFields: true,
  productId: true,
  createErrorCode: true,
} satisfies Prisma.CatalogImportItemSelect;

export async function listItems(
  storeId: string,
  jobId: string,
  opts: { status?: string; flagged?: boolean; limit?: number; cursor?: string }
) {
  await requireJob(storeId, jobId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const rows = await (
    await storeDb(storeId)
  ).catalogImportItem.findMany({
    where: {
      jobId,
      storeId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.flagged === true ? { NOT: { flags: { isEmpty: true } } } : {}),
      ...(opts.flagged === false ? { flags: { isEmpty: true } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: ITEM_SELECT,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export interface ItemPatch {
  name?: string | null;
  nameAr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
  priceMinor?: number | null;
  compareAtMinor?: number | null;
  sku?: string | null;
  categoryId?: string | null;
  createCategory?: boolean;
  tags?: string[];
  variants?: Array<{
    options: Record<string, string>;
    priceMinor: number | null;
    sku?: string | null;
  }>;
  status?: 'accepted' | 'rejected' | 'pending';
  acknowledge?: string[];
}

const TEXT_FIELDS = {
  name: CATALOGUE_LIMITS.name,
  nameAr: CATALOGUE_LIMITS.name,
  description: CATALOGUE_LIMITS.description,
  descriptionAr: CATALOGUE_LIMITS.description,
  sku: CATALOGUE_LIMITS.sku,
} as const;

export async function patchItem(storeId: string, jobId: string, itemId: string, patch: ItemPatch) {
  const item = await (
    await storeDb(storeId)
  ).catalogImportItem.findFirst({
    where: { id: itemId, jobId, storeId },
    select: ITEM_SELECT,
  });
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Item not found.');
  if (item.status === 'created') {
    throw new AppError(409, 'ALREADY_CREATED', 'A draft was already created from this item.');
  }

  const data: Prisma.CatalogImportItemUncheckedUpdateInput = {};
  const edited = new Set(item.editedFields);
  const flags = new Set(item.flags);

  // A merchant paste is not trusted either: same sanitiser, redaction and injection check.
  for (const [key, max] of Object.entries(TEXT_FIELDS) as Array<
    [keyof typeof TEXT_FIELDS, number]
  >) {
    if (patch[key] === undefined) continue;
    let v: string | null = null;
    if (patch[key] !== null) {
      const r = redactPersonalData(sanitizeCatalogueText(patch[key], max));
      if (r.removed.length) flags.add('phone_removed');
      if (injectionMarkers(r.text).length) flags.add('injection_suspected');
      v = r.text || null;
    }
    data[key] = v;
    edited.add(key);
  }
  if (patch.priceMinor !== undefined) {
    data.priceMinor = patch.priceMinor;
    edited.add('priceMinor');
    // A typed price settles the "price unclear / missing / range" doubts.
    for (const f of ['price_unclear', 'no_price', 'price_range', 'currency_mismatch']) {
      if (patch.priceMinor !== null) flags.delete(f);
    }
  }
  if (patch.compareAtMinor !== undefined) {
    data.compareAtMinor = patch.compareAtMinor;
    edited.add('compareAtMinor');
  }
  if (patch.categoryId !== undefined) {
    if (patch.categoryId) {
      const cat = await (
        await storeDb(storeId)
      ).category.findFirst({
        where: { id: patch.categoryId, storeId, deletedAt: null },
        select: { id: true },
      });
      if (!cat) throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
    }
    data.categoryId = patch.categoryId;
    edited.add('categoryId');
  }
  if (patch.tags) {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const t of patch.tags) {
      const c = redactPersonalData(sanitizeCatalogueText(t, CATALOGUE_LIMITS.tag)).text;
      const k = normalizeArabicSearch(c);
      if (c && !seen.has(k)) {
        seen.add(k);
        tags.push(c);
      }
    }
    data.tags = tags.slice(0, 5);
    edited.add('tags');
  }
  if (patch.variants) {
    data.variants = patch.variants.slice(0, 30).map(v => ({
      options: Object.fromEntries(
        Object.entries(v.options)
          .slice(0, 3)
          .map(([k, val]) => [sanitizeCatalogueText(k, 30), sanitizeCatalogueText(val, 60)])
      ),
      priceMinor: v.priceMinor ?? null,
      sku: v.sku ? sanitizeCatalogueText(v.sku, CATALOGUE_LIMITS.sku) : null,
    })) as Prisma.InputJsonValue;
    edited.add('variants');
  }

  const ack = new Set(item.acknowledged);
  for (const a of patch.acknowledge ?? []) ack.add(a);
  if (patch.createCategory === true) ack.add('create_category');
  if (patch.createCategory === false) ack.delete('create_category');

  if (patch.status === 'accepted') {
    const unacked = [...flags].filter(
      f => (BLOCKING_FLAGS as readonly string[]).includes(f) && !ack.has(f)
    );
    if (unacked.length) {
      throw new AppError(409, 'BLOCKING_FLAG', 'Check the flagged fields before accepting.', {
        flags: unacked,
      });
    }
  }
  if (patch.status) data.status = patch.status;
  data.editedFields = [...edited];
  data.flags = [...flags];
  data.acknowledged = [...ack];

  await (
    await storeWriter(storeId)
  ).catalogImportItem.updateMany({ where: { id: itemId, jobId, storeId }, data });
  return (await storeDb(storeId)).catalogImportItem.findFirstOrThrow({
    where: { id: itemId, jobId, storeId },
    select: ITEM_SELECT,
  });
}

/** Accepts only high-confidence items with NO flags at all; flagged items are never touched. */
export async function bulkAcceptHighConfidence(storeId: string, jobId: string) {
  await requireJob(storeId, jobId);
  const r = await (
    await storeWriter(storeId)
  ).catalogImportItem.updateMany({
    where: {
      jobId,
      storeId,
      status: 'pending',
      confidence: { gte: 0.85 },
      flags: { isEmpty: true },
    },
    data: { status: 'accepted' },
  });
  return { accepted: r.count };
}

// ---------------------------------------------------------------------------------------------
// Drafts (the job function calls createDraftForItem once per item)
// ---------------------------------------------------------------------------------------------

export async function startCreateDrafts(storeId: string, jobId: string, itemIds?: string[]) {
  const job = await requireJob(storeId, jobId);
  if (job.status !== 'review' && job.status !== 'done') {
    throw new AppError(409, 'NOT_READY', 'The import is not ready for drafts yet.');
  }
  const queued = await (
    await storeDb(storeId)
  ).catalogImportItem.count({
    where: {
      jobId,
      storeId,
      status: 'accepted',
      productId: null,
      ...(itemIds ? { id: { in: itemIds } } : {}),
    },
  });
  if (queued === 0) throw new AppError(400, 'NOTHING_TO_CREATE', 'Accept at least one item first.');
  await (
    await storeWriter(storeId)
  ).catalogImportJob.updateMany({
    where: { id: jobId, storeId },
    data: { status: 'creating' },
  });
  await enqueue(
    storeId,
    jobId,
    'catalog-import/create-drafts',
    'ENQUEUE_FAILED',
    itemIds ? { itemIds } : {}
  );
  return { queued };
}

const fold = normalizeArabicSearch;

/** Idempotent: re-reads the item guarded by `product_id IS NULL AND status = 'accepted'`. */
export async function createDraftForItem(
  storeId: string,
  itemId: string
): Promise<'created' | 'skipped' | 'failed'> {
  const item = await (
    await storeDb(storeId)
  ).catalogImportItem.findFirst({
    where: { id: itemId, storeId, status: 'accepted', productId: null },
  });
  if (!item) return 'skipped';

  const fail = async (code: string) => {
    await (
      await storeWriter(storeId)
    ).catalogImportItem.updateMany({
      where: { id: itemId, storeId, productId: null },
      data: { status: 'failed', createErrorCode: code },
    });
    return 'failed' as const;
  };
  const name = item.name ?? item.nameAr;
  if (!name) return fail('NAME_MISSING');

  // Category: an existing one, or one the merchant explicitly asked to create.
  let categoryId = item.categoryId;
  if (categoryId) {
    const ok = await (
      await storeDb(storeId)
    ).category.findFirst({
      where: { id: categoryId, storeId, deletedAt: null },
      select: { id: true },
    });
    if (!ok) categoryId = null;
  }
  if (!categoryId && item.categoryName && item.acknowledged.includes('create_category')) {
    const all = await (
      await storeDb(storeId)
    ).category.findMany({
      where: { storeId, deletedAt: null },
      select: { id: true, name: true, nameAr: true },
    });
    const f = fold(item.categoryName);
    categoryId =
      all.find(c => fold(c.name) === f || (c.nameAr && fold(c.nameAr) === f))?.id ?? null;
    if (!categoryId) {
      const base =
        item.categoryName
          .toLowerCase()
          .replace(/[^a-z0-9؀-ۿ]+/g, '-')
          .replace(/(^-|-$)/g, '') || `category-${Date.now()}`;
      let slug = base;
      for (
        let n = 1;
        await (
          await storeDb(storeId)
        ).category.findFirst({ where: { storeId, slug, deletedAt: null } });
        n++
      )
        slug = `${base}-${n}`;
      const isAr = /[؀-ۿ]/.test(item.categoryName);
      const created = await (
        await storeWriter(storeId)
      ).category.create({
        data: { storeId, name: item.categoryName, nameAr: isAr ? item.categoryName : null, slug },
        select: { id: true },
      });
      categoryId = created.id;
    }
  }

  const variants = (Array.isArray(item.variants) ? item.variants : []) as Array<{
    options: Record<string, string>;
    priceMinor: number | null;
    sku?: string | null;
  }>;

  let productId: string;
  try {
    const product = await ProductService.create(storeId, {
      name,
      nameAr: item.nameAr,
      description: item.description,
      descriptionAr: item.descriptionAr,
      price: item.priceMinor ?? 0,
      compareAtPrice: item.compareAtMinor,
      sku: item.sku,
      // Drafts only, always. Publishing is a separate explicit action (publishItems).
      status: 'draft',
      categories: categoryId ? [categoryId] : undefined,
    } as never);
    productId = product.id;
  } catch (err) {
    const e = err as { code?: string; details?: { code?: string } };
    const code =
      e.code === 'PLAN_LIMIT_REACHED'
        ? 'PLAN_LIMIT_REACHED'
        : e.code === 'P2002'
          ? 'SKU_CONFLICT'
          : 'CREATE_FAILED';
    if (code === 'CREATE_FAILED')
      logger.error({ err, itemId }, '[catalog-import] draft create failed');
    return fail(code);
  }

  if (variants.length) {
    const rows: VariantImportRow[] = variants.map(v => {
      const entries = Object.entries(v.options).slice(0, 3);
      return {
        parentSku: item.sku ?? '',
        sku: v.sku ?? undefined,
        price: v.priceMinor ?? undefined,
        inventory: 0,
        option1Name: entries[0]?.[0],
        option1Value: entries[0]?.[1],
        option2Name: entries[1]?.[0],
        option2Value: entries[1]?.[1],
        option3Name: entries[2]?.[0],
        option3Value: entries[2]?.[1],
      };
    });
    try {
      const money = await storeMoney(storeId);
      if (money) {
        // Durable Object store: the variants are one atomic DO section (the CSV import's batch op, replace-semantics on the
        // product just created); `status: 'draft'` is the row's own value, so the product is otherwise untouched (Ruling INTEG-1).
        await money.importBatch({
          rows: [
            {
              rowIndex: 0,
              existingId: productId,
              existingSlug: null,
              slug: '',
              fields: { status: 'draft' },
              imported: {},
              categoryIds: null,
              tagIds: null,
              imageUrls: null,
              variants: rows,
            },
          ],
          aiFields: [],
        });
      } else {
        await withMoneyTx(prisma, tx => createVariantsForProductTx(tx, storeId, productId, rows));
      }
    } catch (err) {
      // Compensate: a draft with half its variants would be worse than no draft.
      logger.error({ err, itemId }, '[catalog-import] variants failed; removing the draft');
      await (await storeWriter(storeId)).product
        .deleteMany({ where: { id: productId, storeId, status: 'draft' } })
        .catch(() => undefined);
      return fail('VARIANTS_FAILED');
    }
  }

  const done = await (
    await storeWriter(storeId)
  ).catalogImportItem.updateMany({
    where: { id: itemId, storeId, productId: null },
    data: { status: 'created', productId, createErrorCode: null },
  });
  return done.count === 1 ? 'created' : 'skipped';
}

export async function finishCreateDrafts(storeId: string, jobId: string) {
  const [created, pending] = await Promise.all([
    (await storeDb(storeId)).catalogImportItem.count({
      where: { jobId, storeId, status: 'created' },
    }),
    (await storeDb(storeId)).catalogImportItem.count({
      where: { jobId, storeId, status: 'accepted', productId: null },
    }),
  ]);
  await (
    await storeWriter(storeId)
  ).catalogImportJob.updateMany({
    where: { id: jobId, storeId, status: 'creating' },
    data: { draftsCreated: created, status: pending === 0 ? 'done' : 'review' },
  });
  await invalidateStoreProductCaches(storeId);
}

// ---------------------------------------------------------------------------------------------
// Publish: the ONLY place this feature writes status 'active', and only for ids the merchant chose
// ---------------------------------------------------------------------------------------------

export async function publishItems(storeId: string, jobId: string, itemIds: string[]) {
  await requireJob(storeId, jobId);
  const items = await (
    await storeDb(storeId)
  ).catalogImportItem.findMany({
    where: { jobId, storeId, id: { in: itemIds } },
    select: {
      id: true,
      productId: true,
      flags: true,
      acknowledged: true,
    },
  });
  const byId = new Map(items.map(i => [i.id, i]));
  const refused: Array<{ itemId: string; code: string }> = [];
  const warnings: Array<{ itemId: string; code: string }> = [];
  const ok: Array<{ itemId: string; productId: string }> = [];
  for (const id of itemIds) {
    const it = byId.get(id);
    if (!it || !it.productId) {
      refused.push({ itemId: id, code: 'NOT_DRAFT' });
      continue;
    }
    const p = await (
      await storeDb(storeId)
    ).product.findFirst({
      where: { id: it.productId, storeId, deletedAt: null },
      select: {
        status: true,
        price: true,
        name: true,
        nameAr: true,
        hasVariants: true,
        variants: { where: { isActive: true }, select: { price: true } },
        images: { select: { id: true }, take: 1 },
      },
    });
    if (!p || p.status !== 'draft') refused.push({ itemId: id, code: 'NOT_DRAFT' });
    else if (!p.name && !p.nameAr) refused.push({ itemId: id, code: 'NAME_MISSING' });
    else if (
      p.hasVariants
        ? p.variants.some(v => !v.price || v.price <= 0) || p.variants.length === 0
        : p.price <= 0
    )
      refused.push({ itemId: id, code: 'PRICE_MISSING' });
    else if (
      it.flags.some(
        f => (BLOCKING_FLAGS as readonly string[]).includes(f) && !it.acknowledged.includes(f)
      )
    )
      refused.push({ itemId: id, code: 'FLAG_UNACKNOWLEDGED' });
    else {
      ok.push({ itemId: id, productId: it.productId });
      if (p.images.length === 0) warnings.push({ itemId: id, code: 'NO_IMAGE' });
    }
  }
  if (ok.length) {
    await BulkService.bulkUpdateStatus(
      storeId,
      ok.map(o => o.productId),
      'active'
    );
    await invalidateStoreProductCaches(storeId);
  }
  return { published: ok.length, refused, warnings };
}
