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
import { storeUpdate } from '../lib/repo-factory';

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
  documents: {
    orderBy: { createdAt: 'asc' as const },
    // storageKey is NEVER selected for a response (ruling TAX-4).
    select: {
      id: true,
      kind: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
    },
  },
} satisfies Prisma.StoreTaxProfileSelect;

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

function toView(
  p: Prisma.StoreTaxProfileGetPayload<{ select: typeof PROFILE_SELECT }> | null
): TaxProfileView {
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
  const existing = await prisma.storeTaxProfile.findUnique({
    where: { storeId },
    select: { id: true, status: true },
  });
  if (existing) return existing;
  return prisma.storeTaxProfile.create({
    data: { storeId },
    select: { id: true, status: true },
  });
}

export class TaxProfileService {
  static async get(storeId: string): Promise<TaxProfileView> {
    const p = await prisma.storeTaxProfile.findUnique({
      where: { storeId },
      select: PROFILE_SELECT,
    });
    return toView(p);
  }

  static async updateDetails(
    storeId: string,
    data: { taxRegistrationNumber: string; legalName: string },
    actor: Actor
  ): Promise<TaxProfileView> {
    const current = await loadOrCreate(storeId);
    assertEditable(current.status);
    const p = await prisma.storeTaxProfile.update({
      where: { storeId },
      data: { taxRegistrationNumber: data.taxRegistrationNumber, legalName: data.legalName },
      select: PROFILE_SELECT,
    });
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
    const count = await prisma.storeTaxDocument.count({
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
      doc = await prisma.storeTaxDocument.create({
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
        select: PROFILE_SELECT.documents.select,
      });
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
    const doc = await prisma.storeTaxDocument.findFirst({
      where: { id: documentId, storeId },
      select: { id: true, storageKey: true, kind: true },
    });
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Document not found');
    await prisma.storeTaxDocument.delete({ where: { id: doc.id, storeId } });
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
    const doc = await prisma.storeTaxDocument.findFirst({
      where: { id: documentId, storeId },
      select: { storageKey: true, mimeType: true, fileName: true },
    });
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Document not found');
    const { body } = await StorageService.getPrivate(doc.storageKey);
    return { body, mimeType: doc.mimeType, fileName: doc.fileName };
  }

  static async submit(storeId: string, actor: Actor): Promise<TaxProfileView> {
    const current = await prisma.storeTaxProfile.findUnique({
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
    const p = await prisma.storeTaxProfile.update({
      where: { storeId },
      data: {
        status: 'pending',
        attestedAt: now,
        submittedAt: now,
        submittedBy: actor.userId,
        rejectionReason: null,
      },
      select: PROFILE_SELECT,
    });
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
        const current = await prisma.storeTaxProfile.findUnique({
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
        const p = await prisma.storeTaxProfile.update({
          where: { storeId },
          data,
          select: PROFILE_SELECT,
        });
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
    const p = await prisma.storeTaxProfile.findUnique({
      where: { storeId },
      select: { status: true },
    });
    return p?.status === 'verified';
  }
}
