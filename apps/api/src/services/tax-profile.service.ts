import { createHash } from 'node:crypto';
import { prisma, withUser, type Prisma } from '@ebda/database';
import {
  TAX_DOCUMENT_MAX_BYTES,
  TAX_DOCUMENT_MAX_COUNT,
  TAX_DOCUMENT_MIME_TYPES,
  TAX_PROFILE_EDITABLE_STATUSES,
  type TaxDocumentKindValue,
  type TaxProfileStatusValue,
  type TaxReviewDecision,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import { StorageService } from './storage.service';
import { bustStoreCachesById } from './store.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import logger from '../lib/logger';
import { listDirectoryStores } from './platform/directory-d1';
import { platformHubOnD1 } from '../lib/platform-scope';
import { taxProfilesForReview, type TaxReviewRow } from '../lib/definer';
import { storeDb, storeRepo, storeUpdate, storeWriter } from '../lib/repo-factory';

/**
 * Egypt VAT gate (ruling TAX-2): the merchant's VAT-registration profile and
 * its evidence, plus the super-admin review. `resolveActiveTaxRate`
 * (lib/order-tax.ts) charges VAT only while this profile is `verified`.
 *
 * Writes that change whether VAT is collected (approve, revoke) bust the
 * public store caches — `taxRatePercent` rides the cached storefront payload,
 * a NEVER-stale value (an unregistered store must not keep showing VAT, a
 * verified one must start immediately). Every status write busts, from every
 * writer in this file; there is no other writer of `store_tax_profiles.status`.
 */

type Actor = { userId: string; ip?: string; userAgent?: string };

const DOC_SELECT = {
  id: true,
  kind: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
} satisfies Prisma.StoreTaxDocumentSelect;

// storageKey is NEVER selected for a response (ruling TAX-4).
const PROFILE_SELECT = {
  id: true,
  status: true,
  taxRegistrationNumber: true,
  legalName: true,
  attestedAt: true,
  submittedAt: true,
  reviewedAt: true,
  verifiedAt: true,
  revokedAt: true,
  rejectionReason: true,
} satisfies Prisma.StoreTaxProfileSelect;

type ProfileWithDocs = Prisma.StoreTaxProfileGetPayload<{ select: typeof PROFILE_SELECT }> & {
  documents: Array<Prisma.StoreTaxDocumentGetPayload<{ select: typeof DOC_SELECT }>>;
};

export type TaxProfileView = {
  status: TaxProfileStatusValue;
  taxRegistrationNumber: string | null;
  legalName: string | null;
  attestedAt: Date | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  verifiedAt: Date | null;
  revokedAt: Date | null;
  rejectionReason: string | null;
  documents: Array<{
    id: string;
    kind: TaxDocumentKindValue;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: Date;
  }>;
};

const EMPTY_PROFILE: TaxProfileView = {
  status: 'none',
  taxRegistrationNumber: null,
  legalName: null,
  attestedAt: null,
  submittedAt: null,
  reviewedAt: null,
  verifiedAt: null,
  revokedAt: null,
  rejectionReason: null,
  documents: [],
};

function toView(p: ProfileWithDocs | null): TaxProfileView {
  if (!p) return EMPTY_PROFILE;
  const { id: _id, ...rest } = p;
  return rest;
}

function bustPublicTaxCaches(storeId: string): void {
  void deferAfterTenantCommit('taxProfile.bustStoreCaches', () =>
    bustStoreCachesById(storeId)
  ).catch(err => logger.error({ err, storeId }, '[tax-profile] public store cache bust failed'));
}

function assertEditable(status: TaxProfileStatusValue): void {
  if (!TAX_PROFILE_EDITABLE_STATUSES.includes(status)) {
    throw new AppError(
      409,
      'TAX_PROFILE_LOCKED',
      status === 'pending'
        ? 'Your VAT registration is under review and cannot be changed now. / طلب التسجيل الضريبي قيد المراجعة ولا يمكن تعديله الآن.'
        : 'A verified VAT registration can only be changed by Ebda AI Studio support. / لا يمكن تعديل التسجيل الضريبي الموثّق إلا عن طريق دعم ابدأ ستوديو للذكاء الاصطناعي.'
    );
  }
}

/** The DO's review guard (and the Postgres trigger) refuse a non-super-admin write with this message prefix. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/tax profile: /.test(msg))
      throw new AppError(
        403,
        'TAX_PROFILE_FORBIDDEN',
        'This change is reserved to a platform super admin'
      );
    throw err;
  }
}

/** Profile + its documents as two flat reads (no nested relation select: the DO's prisma-lite has no include). */
async function readProfile(storeId: string): Promise<ProfileWithDocs | null> {
  const db = await storeDb(storeId);
  const p = await db.storeTaxProfile.findUnique({ where: { storeId }, select: PROFILE_SELECT });
  if (!p) return null;
  const documents = await db.storeTaxDocument.findMany({
    where: { storeId, profileId: p.id },
    orderBy: { createdAt: 'asc' },
    select: DOC_SELECT,
  });
  return { ...p, documents };
}

/** Sniff the real type from the first bytes; the client's mimetype is not trusted. */
export function sniffTaxDocumentMime(buf: Buffer): (typeof TAX_DOCUMENT_MIME_TYPES)[number] | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-')
    return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  return null;
}

const EXT: Record<(typeof TAX_DOCUMENT_MIME_TYPES)[number], string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

async function loadOrCreate(storeId: string) {
  const existing = await (
    await storeDb(storeId)
  ).storeTaxProfile.findUnique({
    where: { storeId },
    select: { id: true, status: true },
  });
  if (existing) return existing;
  try {
    return await (
      await storeWriter(storeId)
    ).storeTaxProfile.create({
      data: { storeId },
      select: { id: true, status: true },
    });
  } catch (err) {
    // two first requests raced: the unique (store_id) refused the second; the row exists now
    const again = await (
      await storeDb(storeId)
    ).storeTaxProfile.findUnique({
      where: { storeId },
      select: { id: true, status: true },
    });
    if (again) return again;
    throw err;
  }
}

/**
 * The super-admin's scope for ONE store's tax profile. A Durable Object store has no Postgres row to scope to (its profile is in the
 * DO), so the handler runs in the request's user scope; every other store keeps `withUser(admin, …, storeId)` (both GUCs).
 */
export async function inReviewScope<T>(
  adminId: string,
  storeId: string,
  fn: () => Promise<T>
): Promise<T> {
  const repo = await storeRepo(storeId);
  return repo.backend === 'do' ? fn() : withUser(adminId, fn, storeId);
}

/** Stores read at once by the review queue (each is one Durable Object round trip). */
const QUEUE_CONCURRENCY = 8;
/** The definer's own cap. */
const QUEUE_LIMIT = 500;

/**
 * The super-admin review queue. With the platform hub on D1 (NEON-ZERO, Ruling NZ-C-7) the directory is D1 `stores` and each
 * store's profile is read from that store's own backend (`storeDb`: its Durable Object); the Postgres definer
 * `ebda_tax_profiles_for_review` is used only before the cutover. Same rows, same order (submittedAt ascending, nulls last),
 * same 500 cap, same duplicate-TRN signal (OTHER stores holding the TRN in pending/verified).
 */
export async function listProfilesForReview(status: string | null): Promise<TaxReviewRow[]> {
  if (!(await platformHubOnD1())) return taxProfilesForReview(status);
  const stores = await listDirectoryStores();
  const found: Array<{ row: TaxReviewRow; store: string }> = [];
  for (let i = 0; i < stores.length; i += QUEUE_CONCURRENCY) {
    const batch = stores.slice(i, i + QUEUE_CONCURRENCY);
    const read = await Promise.all(
      batch.map(async s => {
        const db = await storeDb(s.id);
        const p = await db.storeTaxProfile.findUnique({
          where: { storeId: s.id },
          select: {
            id: true,
            status: true,
            taxRegistrationNumber: true,
            legalName: true,
            submittedAt: true,
            reviewedAt: true,
            verifiedAt: true,
            rejectionReason: true,
          },
        });
        if (!p || (status === null ? p.status === 'none' : p.status !== status)) return null;
        const documentCount = await db.storeTaxDocument.count({ where: { profileId: p.id } });
        return {
          store: s.id,
          row: {
            storeId: s.id,
            storeName: s.name,
            storeSlug: s.slug,
            status: p.status as string,
            taxRegistrationNumber: p.taxRegistrationNumber,
            legalName: p.legalName,
            submittedAt: p.submittedAt,
            reviewedAt: p.reviewedAt,
            verifiedAt: p.verifiedAt,
            rejectionReason: p.rejectionReason,
            documentCount,
            duplicateTrnStores: 0,
          },
        };
      })
    );
    for (const r of read) if (r) found.push(r);
  }
  // The duplicate signal needs every store's TRN (not only the filtered ones): a pending profile is a duplicate of a verified one.
  const holders = new Map<string, Set<string>>();
  const needTrn = found.filter(f => f.row.taxRegistrationNumber);
  if (needTrn.length > 0) {
    for (let i = 0; i < stores.length; i += QUEUE_CONCURRENCY) {
      await Promise.all(
        stores.slice(i, i + QUEUE_CONCURRENCY).map(async s => {
          const p = await (
            await storeDb(s.id)
          ).storeTaxProfile.findUnique({
            where: { storeId: s.id },
            select: { status: true, taxRegistrationNumber: true },
          });
          if (p?.taxRegistrationNumber && (p.status === 'pending' || p.status === 'verified')) {
            const set = holders.get(p.taxRegistrationNumber) ?? new Set<string>();
            set.add(s.id);
            holders.set(p.taxRegistrationNumber, set);
          }
        })
      );
    }
  }
  for (const f of found) {
    const set = f.row.taxRegistrationNumber ? holders.get(f.row.taxRegistrationNumber) : undefined;
    f.row.duplicateTrnStores = set ? [...set].filter(id => id !== f.store).length : 0;
  }
  const at = (d: Date | null) => (d ? d.getTime() : Number.POSITIVE_INFINITY);
  return found
    .map(f => f.row)
    .sort((a, b) => at(a.submittedAt) - at(b.submittedAt))
    .slice(0, QUEUE_LIMIT);
}

export class TaxProfileService {
  static async get(storeId: string): Promise<TaxProfileView> {
    return toView(await readProfile(storeId));
  }

  static async updateDetails(
    storeId: string,
    data: { taxRegistrationNumber: string; legalName: string },
    actor: Actor
  ): Promise<TaxProfileView> {
    const current = await loadOrCreate(storeId);
    assertEditable(current.status);
    // ONE conditional write: a super-admin approving between the read above and this write is not overwritten.
    const written = await guarded(async () =>
      (await storeWriter(storeId)).storeTaxProfile.updateMany({
        where: { storeId, status: { in: [...TAX_PROFILE_EDITABLE_STATUSES] } },
        data: { taxRegistrationNumber: data.taxRegistrationNumber, legalName: data.legalName },
      })
    );
    const p = await readProfile(storeId);
    if (written.count === 0) assertEditable((p?.status ?? 'pending') as TaxProfileStatusValue);
    await auditLog({
      action: 'tax_profile.details_updated',
      userId: actor.userId,
      storeId,
      resourceType: 'store_tax_profile',
      resourceId: current.id,
      details: { taxRegistrationNumberLast3: data.taxRegistrationNumber.slice(-3) },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return toView(p);
  }

  static async addDocument(
    storeId: string,
    kind: TaxDocumentKindValue,
    file: { buffer: Buffer; originalname: string },
    actor: Actor
  ): Promise<TaxProfileView['documents'][number]> {
    const current = await loadOrCreate(storeId);
    assertEditable(current.status);
    if (file.buffer.length === 0 || file.buffer.length > TAX_DOCUMENT_MAX_BYTES) {
      throw new AppError(400, 'FILE_TOO_LARGE', 'Document must be between 1 byte and 10 MB');
    }
    const mime = sniffTaxDocumentMime(file.buffer);
    if (!mime) {
      throw new AppError(
        400,
        'INVALID_FILE_TYPE',
        'Upload a PDF, JPG or PNG. / ارفع ملف PDF أو JPG أو PNG.'
      );
    }
    const count = await (
      await storeDb(storeId)
    ).storeTaxDocument.count({
      where: { storeId, profileId: current.id },
    });
    if (count >= TAX_DOCUMENT_MAX_COUNT) {
      throw new AppError(
        409,
        'TOO_MANY_DOCUMENTS',
        `At most ${TAX_DOCUMENT_MAX_COUNT} documents. Remove one first.`
      );
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const fileName = (file.originalname || `document${EXT[mime]}`).slice(0, 200);
    // PRIVATE bucket only (ruling TAX-4). Throws 503 PRIVATE_STORAGE_NOT_CONFIGURED
    // when it is not configured — never falls back to the public bucket.
    const { key } = await StorageService.putPrivate(file.buffer, {
      storeId,
      folder: 'tax-documents',
      ext: EXT[mime],
      contentType: mime,
    });
    let doc;
    try {
      doc = await guarded(async () =>
        (await storeWriter(storeId)).storeTaxDocument.create({
          data: {
            storeId,
            profileId: current.id,
            kind,
            storageKey: key,
            fileName,
            mimeType: mime,
            sizeBytes: file.buffer.length,
            sha256,
            uploadedBy: actor.userId,
          },
          select: DOC_SELECT,
        })
      );
    } catch (err) {
      // Compensate: the object would otherwise sit unreferenced in the private
      // bucket (no orphan sweep runs there).
      await StorageService.deletePrivate(key).catch(e =>
        logger.error({ err: e, storeId }, '[tax-profile] could not remove orphaned private object')
      );
      throw err;
    }
    await auditLog({
      action: 'tax_profile.document_uploaded',
      userId: actor.userId,
      storeId,
      resourceType: 'store_tax_document',
      resourceId: doc.id,
      details: { kind, mime, sizeBytes: file.buffer.length, sha256 },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return doc;
  }

  static async deleteDocument(storeId: string, documentId: string, actor: Actor): Promise<void> {
    const current = await loadOrCreate(storeId);
    assertEditable(current.status);
    const doc = await (
      await storeDb(storeId)
    ).storeTaxDocument.findFirst({
      where: { id: documentId, storeId },
      select: { id: true, storageKey: true, kind: true },
    });
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Document not found');
    await guarded(async () =>
      (await storeWriter(storeId)).storeTaxDocument.delete({ where: { id: doc.id, storeId } })
    );
    const storageKey = doc.storageKey;
    void deferAfterTenantCommit('taxProfile.deletePrivateObject', () =>
      StorageService.deletePrivate(storageKey)
    ).catch(err =>
      logger.error({ err, storeId }, '[tax-profile] private evidence object delete failed')
    );
    await auditLog({
      action: 'tax_profile.document_deleted',
      userId: actor.userId,
      storeId,
      resourceType: 'store_tax_document',
      resourceId: doc.id,
      details: { kind: doc.kind },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  /** Bytes of one evidence file, for the store's admins or a super-admin. */
  static async readDocument(
    storeId: string,
    documentId: string
  ): Promise<{ body: Buffer; mimeType: string; fileName: string }> {
    const doc = await (
      await storeDb(storeId)
    ).storeTaxDocument.findFirst({
      where: { id: documentId, storeId },
      select: { storageKey: true, mimeType: true, fileName: true },
    });
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Document not found');
    const { body } = await StorageService.getPrivate(doc.storageKey);
    return { body, mimeType: doc.mimeType, fileName: doc.fileName };
  }

  static async submit(storeId: string, actor: Actor): Promise<TaxProfileView> {
    const current = await (
      await storeDb(storeId)
    ).storeTaxProfile.findUnique({
      where: { storeId },
      select: {
        id: true,
        status: true,
        taxRegistrationNumber: true,
        legalName: true,
        _count: { select: { documents: true } },
      },
    });
    if (!current) {
      throw new AppError(
        400,
        'TAX_PROFILE_INCOMPLETE',
        'Enter your tax registration number and legal name and upload your tax card first. / أدخل رقم التسجيل الضريبي والاسم القانوني وارفع البطاقة الضريبية أولًا.'
      );
    }
    assertEditable(current.status);
    if (!current.taxRegistrationNumber || !current.legalName || current._count.documents === 0) {
      throw new AppError(
        400,
        'TAX_PROFILE_INCOMPLETE',
        'Enter your tax registration number and legal name and upload your tax card first. / أدخل رقم التسجيل الضريبي والاسم القانوني وارفع البطاقة الضريبية أولًا.'
      );
    }
    const now = new Date();
    // conditional at the storage layer: only an editable, complete profile with evidence moves to pending
    const moved = await guarded(async () =>
      (await storeWriter(storeId)).storeTaxProfile.updateMany({
        where: {
          storeId,
          status: { in: [...TAX_PROFILE_EDITABLE_STATUSES] },
          taxRegistrationNumber: { not: null },
          legalName: { not: null },
          documents: { some: {} },
        },
        data: {
          status: 'pending',
          attestedAt: now,
          submittedAt: now,
          submittedBy: actor.userId,
          rejectionReason: null,
        },
      })
    );
    const p = await readProfile(storeId);
    if (moved.count === 0) {
      assertEditable((p?.status ?? 'pending') as TaxProfileStatusValue);
      throw new AppError(
        400,
        'TAX_PROFILE_INCOMPLETE',
        'Enter your tax registration number and legal name and upload your tax card first. / أدخل رقم التسجيل الضريبي والاسم القانوني وارفع البطاقة الضريبية أولًا.'
      );
    }
    bustPublicTaxCaches(storeId);
    await auditLog({
      action: 'tax_profile.submitted',
      userId: actor.userId,
      storeId,
      resourceType: 'store_tax_profile',
      resourceId: current.id,
      details: { from: current.status, to: 'pending', attested: true },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return toView(p);
  }

  /**
   * Super-admin decision. The ROUTE is super_admin-only; the database trigger
   * `tax_profile_review_guard` independently refuses the transition for any
   * caller that is not an active super_admin (`app.current_user_id`), so it
   * runs under `withUser(admin, …, storeId)` to carry both GUCs.
   */
  static async review(
    storeId: string,
    decision: TaxReviewDecision,
    actor: Actor
  ): Promise<TaxProfileView> {
    return withUser(
      actor.userId,
      async () => {
        const current = await (
          await storeDb(storeId)
        ).storeTaxProfile.findUnique({
          where: { storeId },
          select: { id: true, status: true },
        });
        if (!current) throw new AppError(404, 'NOT_FOUND', 'No tax profile for this store');
        const now = new Date();
        let data: Prisma.StoreTaxProfileUpdateInput;
        if (decision.decision === 'approve') {
          if (current.status !== 'pending') {
            throw new AppError(
              409,
              'INVALID_TRANSITION',
              `Cannot approve a ${current.status} profile`
            );
          }
          data = {
            status: 'verified',
            verifiedAt: now,
            reviewedAt: now,
            reviewedBy: actor.userId,
            rejectionReason: null,
            revokedAt: null,
          };
        } else if (decision.decision === 'reject') {
          if (current.status !== 'pending') {
            throw new AppError(
              409,
              'INVALID_TRANSITION',
              `Cannot reject a ${current.status} profile`
            );
          }
          data = {
            status: 'rejected',
            reviewedAt: now,
            reviewedBy: actor.userId,
            rejectionReason: decision.reason,
          };
        } else {
          if (current.status !== 'verified') {
            throw new AppError(
              409,
              'INVALID_TRANSITION',
              `Cannot revoke a ${current.status} profile`
            );
          }
          data = {
            status: 'revoked',
            revokedAt: now,
            reviewedAt: now,
            reviewedBy: actor.userId,
            rejectionReason: decision.reason,
          };
        }
        // conditional on the status the decision was read against: two reviewers cannot both move one profile
        const from = decision.decision === 'revoke' ? 'verified' : 'pending';
        const moved = await guarded(async () =>
          (await storeWriter(storeId)).storeTaxProfile.updateMany({
            where: { storeId, status: from },
            data: data as never,
          })
        );
        if (moved.count === 0)
          throw new AppError(
            409,
            'INVALID_TRANSITION',
            `Cannot ${decision.decision} this profile any more`
          );
        const p = await readProfile(storeId);
        if (decision.decision === 'revoke') {
          // Turn the merchant's switch off too: a later re-verification must not
          // silently restart VAT without the merchant choosing it (ruling TAX-3).
          await storeUpdate(prisma, { where: { id: storeId }, data: { taxEnabled: false } });
        }
        bustPublicTaxCaches(storeId);
        await auditLog({
          action: `tax_profile.${decision.decision === 'approve' ? 'approved' : decision.decision === 'reject' ? 'rejected' : 'revoked'}`,
          userId: actor.userId,
          storeId,
          resourceType: 'store_tax_profile',
          resourceId: current.id,
          details: {
            from: current.status,
            to: data.status,
            ...(decision.decision !== 'approve' ? { reason: decision.reason } : {}),
          },
          ip: actor.ip,
          userAgent: actor.userAgent,
        });
        return toView(p);
      },
      storeId
    );
  }

  /** Is this store's VAT registration verified? (the settings write gate) */
  static async isVerified(storeId: string): Promise<boolean> {
    const p = await (
      await storeDb(storeId)
    ).storeTaxProfile.findUnique({
      where: { storeId },
      select: { status: true },
    });
    return p?.status === 'verified';
  }
}
