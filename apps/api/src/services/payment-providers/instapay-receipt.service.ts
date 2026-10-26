/**
 * InstaPay transfer receipts (money batch A, Rulings EBDA-MONEYA-1..6).
 *
 * Whoever pays by InstaPay uploads the receipt screenshot:
 *   - `subscription`: a merchant paying Ebda. The super-admin approves (and ONLY the
 *     super-admin: the merchant can never act on its own subscription payment).
 *   - `order`: a shopper paying a store order. The store's own owner/staff approve
 *     (Ebda super-admin has no action on it).
 *
 * Lifecycle: upload -> `draft` (image in the PRIVATE bucket only, fail-closed) -> the
 * AI job pre-fills `extracted` (or fails: manual entry) -> the payer corrects and
 * submits -> `submitted` with the automatic FLAGS (never a block, except an exact
 * duplicate reference anywhere, refused by the UNIQUE `reference_key`) -> a human
 * approves (`approved`) or rejects with a reason (`rejected`, reference freed).
 * NOTHING activates on a receipt alone: approval goes through the existing money paths
 * (`recordManualPayment` for subscriptions, `InstapayService.confirm` for orders).
 */
import crypto from 'crypto';
import { prisma, withStore, type Prisma } from '@ebda/database';
import {
  INSTAPAY_RECEIPT_LOW_CONFIDENCE,
  INSTAPAY_RECEIPT_MAX_BYTES,
  REGION,
  hasInstructionLikeText,
  normalizeInstapayReceiver,
  normalizeInstapayReference,
  zonedLocalToUtc,
  type InstapayReceiptExtraction,
  type InstapayReceiptFields,
  type InstapayReceiptFlag,
  type InstapayReceiptMime,
  type InstapayReceiptView,
} from '@ebda/shared';
import { AppError } from '../../middleware/error-handler';
import { sniffImage } from '../../lib/upload-sniff';
import logger from '../../lib/logger';
import { inngest } from '../../lib/inngest/client';
import { isP2002 } from '../../lib/prisma-errors';
import { withSavepoint } from '../../lib/savepoint';
import { StorageService } from '../storage.service';
import { readInstapayReceipt } from '../../lib/ai/instapay-receipt-reader';

export type ReceiptKind = 'subscription' | 'order';
type ReceiptRow = Prisma.InstapayReceiptGetPayload<Record<string, never>>;

/** Per target: how many receipts may be uploaded (abuse cap on top of the IP/user rate limit). */
export const MAX_RECEIPTS_PER_ORDER = 6;
export const MAX_SUBSCRIPTION_RECEIPTS_PER_DAY = 10;
const FUTURE_TOLERANCE_MS = 10 * 60_000;

const EXT: Record<InstapayReceiptMime, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/**
 * Sniff the real type from the first bytes; the client's mimetype is not trusted. One sniffer for
 * every upload (`lib/upload-sniff.ts`); a receipt is a screenshot or photo, so GIF is refused.
 */
export function sniffReceiptMime(buf: Buffer): InstapayReceiptMime | null {
  const kind = sniffImage(buf);
  return kind === 'image/jpeg' || kind === 'image/png' || kind === 'image/webp' ? kind : null;
}

/** The receipt's local (Cairo) date + time as the instant it happened. */
export function transferInstant(fields: { transferDate: string; transferTime: string }): Date {
  const at = zonedLocalToUtc(fields.transferDate, fields.transferTime, REGION.timezone);
  if (!at)
    throw new AppError(400, 'INVALID_TRANSFER_DATE', 'The transfer date or time is not valid');
  return at;
}

export interface FlagInput {
  fields: InstapayReceiptFields;
  transferredAt: Date;
  extraction: InstapayReceiptExtraction | null;
  extractionStatus: string;
  expectedAmountMinor: number | null;
  /** Any of these (IPA or mobile) is the right receiver. */
  expectedReceivers: string[];
  /** The transfer must not predate this (order creation / last subscription payment). */
  notBefore: Date | null;
  notBeforeFlag: 'DATE_BEFORE_ORDER' | 'DATE_TOO_OLD';
  sameImageSeenBefore: boolean;
  now: Date;
}

/** The automatic checks for the approver (pure). They flag; they never block. */
export function computeReceiptFlags(i: FlagInput): InstapayReceiptFlag[] {
  const flags: InstapayReceiptFlag[] = [];
  if (i.expectedAmountMinor !== null && i.fields.amountMinor !== i.expectedAmountMinor) {
    flags.push('AMOUNT_MISMATCH');
  }
  const expected = i.expectedReceivers
    .map(r => normalizeInstapayReceiver(r))
    .filter((r): r is string => !!r);
  const shown = [i.fields.receiverHandle, i.fields.receiverMobile]
    .map(r => normalizeInstapayReceiver(r))
    .filter((r): r is string => !!r);
  if (shown.length === 0) flags.push('RECEIVER_MISSING');
  else if (expected.length > 0 && !shown.some(s => expected.includes(s))) {
    flags.push('RECEIVER_MISMATCH');
  }
  if (i.notBefore && i.transferredAt.getTime() < i.notBefore.getTime()) flags.push(i.notBeforeFlag);
  if (i.transferredAt.getTime() > i.now.getTime() + FUTURE_TOLERANCE_MS)
    flags.push('DATE_IN_FUTURE');
  if (i.extractionStatus !== 'done' || !i.extraction) {
    flags.push('AI_UNAVAILABLE');
  } else {
    if (i.extraction.confidence < INSTAPAY_RECEIPT_LOW_CONFIDENCE) flags.push('LOW_CONFIDENCE');
    if (i.extraction.looksEdited) flags.push('LOOKS_EDITED');
    const e = i.extraction;
    // Rule-based, so a screenshot cannot instruct the reader into silence (SEC-11).
    if (
      hasInstructionLikeText([
        e.note,
        e.payerName,
        e.receiverName,
        e.payerAddress,
        e.receiverHandle,
        e.payerBank,
      ])
    ) {
      flags.push('SUSPICIOUS_TEXT');
    }
    const corrected =
      (e.amountMinor !== null && e.amountMinor !== i.fields.amountMinor) ||
      (e.reference !== null &&
        normalizeInstapayReference(e.reference) !==
          normalizeInstapayReference(i.fields.reference)) ||
      (e.transferDate !== null && e.transferDate !== i.fields.transferDate) ||
      (e.transferTime !== null && e.transferTime !== i.fields.transferTime);
    if (corrected) flags.push('FIELDS_CORRECTED');
  }
  if (i.sameImageSeenBefore) flags.push('SAME_IMAGE_USED_BEFORE');
  return flags;
}

export function toReceiptView(r: ReceiptRow): InstapayReceiptView {
  return {
    id: r.id,
    kind: r.kind as ReceiptKind,
    status: r.status as InstapayReceiptView['status'],
    extractionStatus: r.extractionStatus as InstapayReceiptView['extractionStatus'],
    extracted: (r.extracted as unknown as InstapayReceiptExtraction | null) ?? null,
    confidence: r.confidence,
    fields: {
      amountMinor: r.amountMinor,
      reference: r.reference,
      transferredAt: r.transferredAt?.toISOString() ?? null,
      payerName: r.payerName,
      payerAddress: r.payerAddress,
      payerMobile: r.payerMobile,
      payerBank: r.payerBank,
      receiverName: r.receiverName,
      receiverHandle: r.receiverHandle,
      receiverMobile: r.receiverMobile,
      note: r.note,
    },
    expectedAmountMinor: r.expectedAmountMinor,
    expectedReceiver: r.expectedReceiver,
    flags: r.flags as InstapayReceiptFlag[],
    reviewNote: r.reviewNote,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export class InstapayReceiptService {
  /**
   * Store the screenshot (private bucket ONLY; 503 when it is not configured — never a
   * public fallback) and create the draft, then queue the AI read. A queue failure
   * marks the read failed at once so the payer falls back to manual entry.
   */
  static async upload(args: {
    storeId: string;
    kind: ReceiptKind;
    orderId?: string | null;
    paymentId?: string | null;
    file: Buffer;
    now?: Date;
  }): Promise<InstapayReceiptView> {
    const { storeId, kind } = args;
    const now = args.now ?? new Date();
    if (args.file.length === 0 || args.file.length > INSTAPAY_RECEIPT_MAX_BYTES) {
      throw new AppError(400, 'FILE_TOO_LARGE', 'The screenshot must be smaller than 8 MB');
    }
    const mime = sniffReceiptMime(args.file);
    if (!mime) {
      throw new AppError(
        400,
        'INVALID_FILE_TYPE',
        'Upload the receipt screenshot (JPG, PNG or WebP)'
      );
    }
    const count = await withStore(storeId, () =>
      prisma.instapayReceipt.count({
        where:
          kind === 'order'
            ? { storeId, kind, orderId: args.orderId ?? '' }
            : { storeId, kind, createdAt: { gte: new Date(now.getTime() - 86_400_000) } },
      })
    );
    const cap = kind === 'order' ? MAX_RECEIPTS_PER_ORDER : MAX_SUBSCRIPTION_RECEIPTS_PER_DAY;
    if (count >= cap) {
      throw new AppError(
        429,
        'TOO_MANY_RECEIPTS',
        'Too many receipts were uploaded. Contact support.'
      );
    }
    const sha256 = crypto.createHash('sha256').update(args.file).digest('hex');
    const { key } = await StorageService.putPrivate(args.file, {
      storeId,
      folder: 'instapay-receipts',
      ext: EXT[mime],
      contentType: mime,
    });
    let row: ReceiptRow;
    try {
      row = await withStore(storeId, () =>
        prisma.instapayReceipt.create({
          data: {
            storeId,
            kind,
            orderId: args.orderId ?? null,
            paymentId: args.paymentId ?? null,
            storageKey: key,
            mimeType: mime,
            sizeBytes: args.file.length,
            sha256,
          },
        })
      );
    } catch (err) {
      // Compensate: never leave an unreferenced object in the private bucket.
      await StorageService.deletePrivate(key).catch(e =>
        logger.error({ err: e, storeId }, '[instapay-receipt] orphaned private object')
      );
      throw err;
    }
    try {
      await inngest.send({
        name: 'instapay/receipt-extract',
        data: { storeId, receiptId: row.id },
      });
    } catch (err) {
      logger.error({ err, storeId, receiptId: row.id }, '[instapay-receipt] AI read not queued');
      row = await this.markExtractionFailed(storeId, row.id, 'queue_unavailable');
    }
    return toReceiptView(row);
  }

  private static async markExtractionFailed(
    storeId: string,
    receiptId: string,
    reason: string
  ): Promise<ReceiptRow> {
    await withStore(storeId, () =>
      prisma.instapayReceipt.updateMany({
        where: { id: receiptId, storeId, extractionStatus: 'pending' },
        data: { extractionStatus: 'failed', extractionError: reason.slice(0, 200) },
      })
    );
    return withStore(storeId, () =>
      prisma.instapayReceipt.findUniqueOrThrow({ where: { id: receiptId, storeId } })
    );
  }

  /**
   * The AI read (Inngest job, under a store scope: no transaction is held across the
   * Gemini call). Idempotent: only a `pending` read is written. Any failure (timeout,
   * quota, bad JSON, no key) = `failed`, which the payer sees as manual entry.
   */
  static async runExtraction(
    storeId: string,
    receiptId: string
  ): Promise<'done' | 'failed' | 'skipped'> {
    const row = await withStore(storeId, () =>
      prisma.instapayReceipt.findUnique({ where: { id: receiptId, storeId } })
    );
    if (!row || row.extractionStatus !== 'pending') return 'skipped';
    try {
      const { body } = await StorageService.getPrivate(row.storageKey);
      const extraction = await readInstapayReceipt({
        storeId,
        image: body,
        mimeType: row.mimeType,
      });
      await withStore(storeId, () =>
        prisma.instapayReceipt.updateMany({
          where: { id: receiptId, storeId, extractionStatus: 'pending' },
          data: {
            extractionStatus: 'done',
            extracted: extraction as unknown as Prisma.InputJsonValue,
            confidence: extraction.confidence,
          },
        })
      );
      return 'done';
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'ai_failed';
      logger.warn({ err, storeId, receiptId }, '[instapay-receipt] AI read failed, manual entry');
      await this.markExtractionFailed(storeId, receiptId, String(code));
      return 'failed';
    }
  }

  static async get(
    storeId: string,
    receiptId: string,
    scope: { kind: 'subscription' } | { kind: 'order'; orderId: string }
  ): Promise<ReceiptRow> {
    const row = await withStore(storeId, () =>
      prisma.instapayReceipt.findFirst({
        where: {
          id: receiptId,
          storeId,
          kind: scope.kind,
          ...(scope.kind === 'order' ? { orderId: scope.orderId } : {}),
        },
      })
    );
    if (!row) throw new AppError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
    return row;
  }

  static async listForOrder(storeId: string, orderId: string): Promise<InstapayReceiptView[]> {
    const rows = await withStore(storeId, () =>
      prisma.instapayReceipt.findMany({
        where: { storeId, kind: 'order', orderId, status: { not: 'draft' } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
    );
    return rows.map(toReceiptView);
  }

  /** The image bytes for an AUTHORISED approver (the route checks who may call). */
  static async readImage(
    storeId: string,
    receiptId: string,
    scope: { kind: 'subscription' } | { kind: 'order'; orderId: string }
  ): Promise<{ body: Buffer; mimeType: string }> {
    const row = await this.get(storeId, receiptId, scope);
    const { body } = await StorageService.getPrivate(row.storageKey);
    return { body, mimeType: row.mimeType };
  }

  /**
   * The payer submits the (corrected) fields. Computes the flags, freezes what the
   * approver expects, and claims the reference: an exact duplicate ANYWHERE (any store,
   * any kind, while that receipt is live) is refused 409 DUPLICATE_REFERENCE.
   * Runs inside the caller's transaction/scope; `extraWrites` (the claim, the order
   * freeze) run after the reference is claimed, in the same unit of work.
   */
  static async submit(args: {
    storeId: string;
    receiptId: string;
    scope: { kind: 'subscription' } | { kind: 'order'; orderId: string };
    fields: InstapayReceiptFields;
    expectedAmountMinor: number | null;
    expectedReceivers: string[];
    notBefore: Date | null;
    now?: Date;
  }): Promise<ReceiptRow> {
    const now = args.now ?? new Date();
    const row = await this.get(args.storeId, args.receiptId, args.scope);
    if (row.status !== 'draft') {
      throw new AppError(409, 'RECEIPT_NOT_DRAFT', 'This receipt was already submitted');
    }
    const referenceKey = normalizeInstapayReference(args.fields.reference);
    if (!referenceKey) {
      throw new AppError(400, 'INVALID_REFERENCE', 'The transfer reference is 8 to 20 digits');
    }
    const transferredAt = transferInstant(args.fields);
    const seen = await prisma.instapayReceipt.count({
      where: { storeId: args.storeId, sha256: row.sha256, id: { not: row.id } },
    });
    const flags = computeReceiptFlags({
      fields: args.fields,
      transferredAt,
      extraction: (row.extracted as unknown as InstapayReceiptExtraction | null) ?? null,
      extractionStatus: row.extractionStatus,
      expectedAmountMinor: args.expectedAmountMinor,
      expectedReceivers: args.expectedReceivers,
      notBefore: args.notBefore,
      notBeforeFlag: args.scope.kind === 'order' ? 'DATE_BEFORE_ORDER' : 'DATE_TOO_OLD',
      sameImageSeenBefore: seen > 0,
      now,
    });
    try {
      return await withSavepoint(() =>
        prisma.instapayReceipt.update({
          where: { id: row.id, storeId: args.storeId },
          data: {
            status: 'submitted',
            submittedAt: now,
            amountMinor: args.fields.amountMinor,
            reference: args.fields.reference.trim(),
            referenceKey,
            transferredAt,
            payerName: args.fields.payerName,
            payerAddress: args.fields.payerAddress,
            payerMobile: args.fields.payerMobile,
            payerBank: args.fields.payerBank,
            receiverName: args.fields.receiverName,
            receiverHandle: args.fields.receiverHandle,
            receiverMobile: args.fields.receiverMobile,
            note: args.fields.note,
            expectedAmountMinor: args.expectedAmountMinor,
            expectedReceiver: args.expectedReceivers.filter(Boolean).join(' / ') || null,
            flags,
          },
        })
      );
    } catch (err) {
      if (isP2002(err)) {
        throw new AppError(
          409,
          'DUPLICATE_REFERENCE',
          'This transfer reference was already used. Each transfer can pay only once.'
        );
      }
      throw err;
    }
  }

  /** Approver decision on a submitted receipt (called from the money paths, same transaction). */
  static async markReviewed(
    storeId: string,
    receiptId: string,
    decision: { status: 'approved' } | { status: 'rejected'; note: string },
    actorId: string | null,
    now: Date = new Date()
  ): Promise<number> {
    const { count } = await prisma.instapayReceipt.updateMany({
      where: { id: receiptId, storeId, status: 'submitted' },
      data:
        decision.status === 'approved'
          ? { status: 'approved', reviewedBy: actorId, reviewedAt: now }
          : {
              status: 'rejected',
              // A rejected receipt frees its reference: the same transfer may be re-filed.
              referenceKey: null,
              reviewNote: decision.note.slice(0, 500),
              reviewedBy: actorId,
              reviewedAt: now,
            },
    });
    return count;
  }

  /** Free a (approved) receipt's reference after its payment was VOIDED (recorded in error). */
  static async voidByClaim(storeId: string, claimId: string, note: string, actorId: string) {
    return prisma.instapayReceipt.updateMany({
      where: { storeId, claimId },
      data: {
        status: 'voided',
        referenceKey: null,
        reviewNote: note.slice(0, 500),
        reviewedBy: actorId,
        reviewedAt: new Date(),
      },
    });
  }
}

/**
 * The payer's identity read off a receipt screenshot (name, InstaPay address, mobile, bank) is PII
 * of the order's buyer. A viewer without the order's view token (SEC-15) gets the receipt with those
 * fields nulled; amount, reference, status and flags stay so the page still works.
 */
export function maskReceiptPayerPii<T extends { extracted?: unknown; fields?: unknown }>(
  receipt: T
): T {
  const strip = (o: unknown) =>
    o && typeof o === 'object'
      ? {
          ...(o as object),
          payerName: null,
          payerAddress: null,
          payerMobile: null,
          payerBank: null,
        }
      : o;
  return { ...receipt, extracted: strip(receipt.extracted), fields: strip(receipt.fields) };
}
