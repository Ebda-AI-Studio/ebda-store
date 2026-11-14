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
import { prisma, withStore, acrossStores, Prisma } from '@ebda/database';
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
import {
  storeDb,
  storeMoney,
  storeRepo,
  type DoReceipt,
  type MoneyClient,
} from '../../lib/repo-factory';
import { jobsOnDo } from '../../lib/jobs/do-guard';
import {
  claimInstapayReference,
  releaseInstapayReference,
  scheduleClaimRelease,
} from '../../lib/instapay-ref-claim';
import { doStoreIdList } from '../../lib/store-backend';
import { sniffImage } from '../../lib/upload-sniff';
import logger from '../../lib/logger';
import { inngest } from '../../lib/inngest/client';
import { isP2002 } from '../../lib/prisma-errors';
import { withSavepoint } from '../../lib/savepoint';
import { StorageService } from '../storage.service';
import {
  readInstapayReceipt,
  readReceiptForAutoConfirm,
} from '../../lib/ai/instapay-receipt-reader';
import type { ParsedExtraction } from '@ebda/shared';
import { getAutoMode } from '../billing/instapay-auto-settings';
import { instapayHandle } from '../billing/manual-config';

export type ReceiptKind = 'subscription' | 'order';

/** What a scrub clears: everything a person typed or the AI read about a person. Money and evidence columns are untouched. */
export const SCRUBBED_PERSONAL_FIELDS = (now: Date) => ({
  payerName: null,
  payerAddress: null,
  payerMobile: null,
  payerBank: null,
  receiverName: null,
  receiverHandle: null,
  receiverMobile: null,
  note: null,
  extracted: Prisma.DbNull,
  personalScrubbedAt: now,
});
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
  // RECEIVER-CHECK-1: the model compared the screenshot's receiver with the store's expected account(s) and answered
  // yes / no. A "no" flags RECEIVER_MISMATCH whatever the payer typed; a "yes" stands in for the typed fields (a payer who
  // left them blank is not RECEIVER_MISSING). Without that answer (AI failed, no expected receiver) the check is the
  // payer-typed comparison, as before.
  const aiReceiver = i.extractionStatus === 'done' ? (i.extraction?.receiverMatch ?? null) : null;
  if (aiReceiver === false) flags.push('RECEIVER_MISMATCH');
  else if (shown.length === 0) {
    // blank typed fields: a verified image stands in for them
    if (aiReceiver !== true) flags.push('RECEIVER_MISSING');
  } else if (expected.length > 0 && !shown.some(s => expected.includes(s))) {
    // the payer TYPED a receiver that is not the expected account: a model "yes" (a guess, a decoy line on the image, a
    // masked number that agrees on a few digits) never hides that
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

/** A DO order receipt (epoch ms) in the shape the Postgres row has (`Date`), so every consumer stays one code path. */
export function receiptFromDo(r: DoReceipt): ReceiptRow {
  const d = (v: number | null): Date | null => (v === null ? null : new Date(v));
  return {
    id: r.id,
    storeId: r.storeId,
    kind: 'order',
    status: r.status,
    orderId: r.orderId,
    paymentId: r.paymentId,
    claimId: null,
    storageKey: r.storageKey,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    extractionStatus: r.extractionStatus,
    extractionError: r.extractionError,
    extracted: r.extracted as ReceiptRow['extracted'],
    confidence: r.confidence,
    amountMinor: r.amountMinor,
    reference: r.reference,
    referenceKey: r.referenceKey,
    transferredAt: d(r.transferredAt),
    payerName: r.payerName,
    payerAddress: r.payerAddress,
    payerMobile: r.payerMobile,
    payerBank: r.payerBank,
    receiverName: r.receiverName,
    receiverHandle: r.receiverHandle,
    receiverMobile: r.receiverMobile,
    note: r.note,
    expectedAmountMinor: r.expectedAmountMinor,
    expectedReceiver: r.expectedReceiver,
    flags: r.flags,
    reviewNote: r.reviewNote,
    reviewedBy: r.reviewedBy,
    reviewedAt: d(r.reviewedAt),
    submittedAt: d(r.submittedAt),
    imageDeletedAt: d(r.imageDeletedAt),
    personalScrubbedAt: d(r.personalScrubbedAt),
    createdAt: new Date(r.createdAt),
  } as unknown as ReceiptRow;
}

/** The auto-confirm read (`extracted.auto`, INSTAPAY-AUTO-1) is decision input for the API only: never part of a view. */
function withoutAutoRead(extracted: unknown): InstapayReceiptExtraction | null {
  if (!extracted || typeof extracted !== 'object') return null;
  const { auto: _auto, ...rest } = extracted as Record<string, unknown>;
  return rest as unknown as InstapayReceiptExtraction;
}

/** The auto-confirm read stored on a subscription receipt, or null when none was attempted. */
export function autoReadOf(extracted: unknown): { read: ParsedExtraction | null } | null {
  const a = (extracted as { auto?: { read?: ParsedExtraction | null } } | null)?.auto;
  return a ? { read: a.read ?? null } : null;
}

export function toReceiptView(r: ReceiptRow): InstapayReceiptView {
  return {
    id: r.id,
    kind: r.kind as ReceiptKind,
    status: r.status as InstapayReceiptView['status'],
    extractionStatus: r.extractionStatus as InstapayReceiptView['extractionStatus'],
    extracted: withoutAutoRead(r.extracted),
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

const duplicateReference = () =>
  new AppError(
    409,
    'DUPLICATE_REFERENCE',
    'This transfer reference was already used. Each transfer can pay only once.'
  );

/**
 * Free the D1 claims of Postgres receipts whose `referenceKey` was just nulled (rejected, voided). Queued, never immediate:
 * the release runs after the transaction COMMITS and is dropped on rollback (`withClaimReleases`, lib/instapay-ref-claim.ts),
 * and is refused outside such a scope.
 */
function freeClaimsAfterCommit(
  storeId: string,
  rows: Array<{ id: string; referenceKey: string | null }>
): void {
  scheduleClaimRelease(
    rows
      .filter((r): r is { id: string; referenceKey: string } => !!r.referenceKey)
      .map(r => ({ referenceKey: r.referenceKey, storeId, receiptId: r.id }))
  );
}

export class InstapayReceiptService {
  /** The money client when this is an ORDER receipt of a store on its Durable Object (Ruling INSTAPAY-DO-1), else null. */
  private static async onDo(storeId: string, kind: string): Promise<MoneyClient | null> {
    return kind === 'order' ? await storeMoney(storeId) : null;
  }

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
    const doMoney = await InstapayReceiptService.onDo(storeId, kind);
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
    if (doMoney) return InstapayReceiptService.uploadOnDo(doMoney, args, mime);
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

  /** The DO twin of `upload`: the draft row is born in the same database as the order, capped there in one section. */
  private static async uploadOnDo(
    money: MoneyClient,
    args: { storeId: string; orderId?: string | null; paymentId?: string | null; file: Buffer },
    mime: InstapayReceiptMime
  ): Promise<InstapayReceiptView> {
    const { storeId } = args;
    const sha256 = crypto.createHash('sha256').update(args.file).digest('hex');
    const { key } = await StorageService.putPrivate(args.file, {
      storeId,
      folder: 'instapay-receipts',
      ext: EXT[mime],
      contentType: mime,
    });
    let row: DoReceipt;
    try {
      row = await money.receiptCreate({
        orderId: args.orderId ?? '',
        paymentId: args.paymentId ?? null,
        storageKey: key,
        mimeType: mime,
        sizeBytes: args.file.length,
        sha256,
      });
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
      await money.receiptExtraction({
        receiptId: row.id,
        status: 'failed',
        error: 'queue_unavailable',
      });
      row = await money.receiptGet({ receiptId: row.id });
    }
    return toReceiptView(receiptFromDo(row));
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
   * AI call). Idempotent: only a `pending` read is written. Any failure (timeout,
   * quota, bad JSON, no key) = `failed`, which the payer sees as manual entry.
   */
  static async runExtraction(
    storeId: string,
    receiptId: string
  ): Promise<'done' | 'failed' | 'skipped'> {
    // an ORDER receipt of a DO store lives in the DO; anything else (subscription receipts) is platform-owned
    const money = await storeMoney(storeId);
    if (money) {
      const mine = await money.receiptGet({ receiptId }).then(
        r => r,
        (e: { code?: string }) => {
          if (e?.code === 'RECEIPT_NOT_FOUND') return null;
          throw e;
        }
      );
      if (mine) return InstapayReceiptService.runExtractionOnDo(money, storeId, mine);
    }
    const row = await withStore(storeId, () =>
      prisma.instapayReceipt.findUnique({ where: { id: receiptId, storeId } })
    );
    if (!row || row.extractionStatus !== 'pending') return 'skipped';
    try {
      const { body } = await StorageService.getPrivate(row.storageKey);
      const expectedReceivers = await this.expectedReceiversFor(storeId, row);
      if (expectedReceivers.length === 0) {
        // P2: nothing to compare the receiver with, so no receiver flag from the AI (the payer-typed check stays).
        logger.warn(
          { storeId, receiptId, kind: row.kind },
          '[P2][instapay-receipt] no expected receiver configured; receiver check skipped'
        );
      }
      const extraction = await readInstapayReceipt({
        storeId,
        image: body,
        mimeType: row.mimeType,
        expectedReceivers,
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

  /**
   * INSTAPAY-AUTO-1 (S3): the typed auto-confirm read of a SUBSCRIPTION receipt, stored on the receipt row beside the legacy extraction
   * (`extracted.auto`, never shown in a view). Runs only while the global mode is not `off` (no extra AI spend with the switch off),
   * once per receipt, and a failed read is stored as `read: null` so the decision can tell "tried, unreadable" from "not tried yet".
   * Order receipts never come through here (M-003).
   */
  static async runAutoExtraction(
    storeId: string,
    receiptId: string
  ): Promise<'done' | 'skipped' | 'unreadable'> {
    const row = await withStore(storeId, () =>
      prisma.instapayReceipt.findUnique({ where: { id: receiptId, storeId } })
    );
    if (!row || row.kind !== 'subscription') return 'skipped';
    if (autoReadOf(row.extracted)) return 'skipped';
    if ((await getAutoMode()) === 'off') return 'skipped';
    let read: ParsedExtraction | null = null;
    try {
      const { body } = await StorageService.getPrivate(row.storageKey);
      read = await readReceiptForAutoConfirm({ bytes: body, mime: row.mimeType }, { storeId });
    } catch (err) {
      logger.warn({ err, storeId, receiptId }, '[instapay-receipt] auto read failed');
    }
    const base = (
      row.extracted && typeof row.extracted === 'object' ? row.extracted : {}
    ) as object;
    await withStore(storeId, () =>
      prisma.instapayReceipt.updateMany({
        where: { id: receiptId, storeId },
        data: {
          extracted: {
            ...base,
            auto: { read, at: new Date().toISOString() },
          } as unknown as Prisma.InputJsonValue,
        },
      })
    );
    return read?.extract ? 'done' : 'unreadable';
  }

  /** A claim submitted before the typed read landed is decided once the read is stored (the stuck sweep covers a lost event). */
  static async enqueueIfClaimed(
    storeId: string,
    receiptId: string
  ): Promise<'queued' | 'skipped' | 'failed'> {
    const row = await withStore(storeId, () =>
      prisma.instapayReceipt.findUnique({ where: { id: receiptId, storeId } })
    );
    if (!row?.claimId || row.kind !== 'subscription' || row.status !== 'submitted')
      return 'skipped';
    const { enqueueAutoConfirm } = await import('../billing/instapay-auto-confirm.service.js');
    return enqueueAutoConfirm(storeId, row.claimId);
  }

  private static async runExtractionOnDo(
    money: MoneyClient,
    storeId: string,
    row: DoReceipt
  ): Promise<'done' | 'failed' | 'skipped'> {
    if (row.extractionStatus !== 'pending') return 'skipped';
    try {
      const { body } = await StorageService.getPrivate(row.storageKey);
      const expectedReceivers = await this.expectedReceiversFor(storeId, receiptFromDo(row));
      const extraction = await readInstapayReceipt({
        storeId,
        image: body,
        mimeType: row.mimeType,
        expectedReceivers,
      });
      await money.receiptExtraction({
        receiptId: row.id,
        status: 'done',
        extracted: extraction,
        confidence: extraction.confidence,
      });
      return 'done';
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'ai_failed';
      logger.warn(
        { err, storeId, receiptId: row.id },
        '[instapay-receipt] AI read failed, manual entry'
      );
      await money.receiptExtraction({ receiptId: row.id, status: 'failed', error: String(code) });
      return 'failed';
    }
  }

  /**
   * The account(s) this receipt's money must have gone to: the order's InstaPay handle and mobile (frozen on its payment),
   * or Ebda's own handle for a subscription receipt. The MERCHANT's details, normalised; empty = no receiver check.
   */
  static async expectedReceiversFor(
    storeId: string,
    row: { kind: string; orderId: string | null; paymentId?: string | null }
  ): Promise<string[]> {
    const raw: unknown[] = [];
    if (row.kind === 'order' && row.orderId) {
      const query: Prisma.PaymentFindFirstArgs = {
        // the payment the receipt was filed against (the account the approver is shown), else the newest pending one
        where: row.paymentId
          ? { id: row.paymentId, orderId: row.orderId!, provider: 'instapay' }
          : { orderId: row.orderId!, provider: 'instapay', status: 'pending' },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true },
      };
      const payment = (await storeMoney(storeId))
        ? await (await storeDb(storeId)).payment.findFirst(query)
        : await withStore(storeId, () => prisma.payment.findFirst(query));
      const m = (
        payment?.metadata && typeof payment.metadata === 'object' ? payment.metadata : {}
      ) as Record<string, unknown>;
      raw.push(m.handle, m.phone);
    } else if (row.kind === 'subscription') {
      raw.push(instapayHandle());
    }
    return [
      ...new Set(
        raw
          .map(v => (typeof v === 'string' ? normalizeInstapayReceiver(v) : null))
          .filter((v): v is string => !!v)
      ),
    ];
  }

  static async get(
    storeId: string,
    receiptId: string,
    scope: { kind: 'subscription' } | { kind: 'order'; orderId: string }
  ): Promise<ReceiptRow> {
    const doMoney = await InstapayReceiptService.onDo(storeId, scope.kind);
    if (doMoney)
      return receiptFromDo(
        await doMoney.receiptGet({
          receiptId,
          orderId: scope.kind === 'order' ? scope.orderId : undefined,
        })
      );
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
    const doMoney = await InstapayReceiptService.onDo(storeId, 'order');
    if (doMoney)
      return (await doMoney.receiptList({ orderId })).map(r => toReceiptView(receiptFromDo(r)));
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
    if (row.imageDeletedAt) {
      throw new AppError(410, 'RECEIPT_IMAGE_DELETED', 'The receipt image is no longer stored');
    }
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
    const doMoney = await InstapayReceiptService.onDo(args.storeId, args.scope.kind);
    if (doMoney) return InstapayReceiptService.submitOnDo(doMoney, args, now);
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
    // One uniqueness space with the Durable Object stores (Ruling INSTAPAY-DO-1): the reference is also claimed in D1
    // `entity_index`, bound to this receipt, before the Postgres write. Without a D1 binding the UNIQUE index decides alone.
    const claim = await claimInstapayReference(referenceKey, args.storeId, row.id);
    if (claim === 'taken') throw duplicateReference();
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
      // The savepoint rolled back, so this receipt is not submitted: free only the claim THIS call made.
      if (claim === 'claimed') await releaseInstapayReference(referenceKey, args.storeId, row.id);
      if (isP2002(err)) throw duplicateReference();
      throw err;
    }
  }

  /**
   * The DO twin of `submit` (Ruling INSTAPAY-DO-1): the receipt, the hold freeze, the payment metadata and the payment event
   * are ONE DO section. The cross-store reference claim is made first and freed again if the section refuses.
   */
  private static async submitOnDo(
    money: MoneyClient,
    args: {
      storeId: string;
      receiptId: string;
      scope: { kind: 'subscription' } | { kind: 'order'; orderId: string };
      fields: InstapayReceiptFields;
      expectedAmountMinor: number | null;
      expectedReceivers: string[];
      notBefore: Date | null;
    },
    now: Date
  ): Promise<ReceiptRow> {
    if (args.scope.kind !== 'order') throw new AppError(400, 'BAD_SCOPE', 'not an order receipt');
    const { storeId, receiptId } = args;
    const orderId = args.scope.orderId;
    const referenceKey = normalizeInstapayReference(args.fields.reference);
    if (!referenceKey) {
      throw new AppError(400, 'INVALID_REFERENCE', 'The transfer reference is 8 to 20 digits');
    }
    const transferredAt = transferInstant(args.fields);
    for (let attempt = 0; ; attempt++) {
      // the DO section decides every refusal (waiting receipt, not a draft), in the Postgres service's order
      const row = await money.receiptGet({ receiptId, orderId });
      const { sameImage } = await money.receiptProof({
        orderId,
        sha256: row.sha256,
        exceptId: row.id,
      });
      const flags = computeReceiptFlags({
        fields: args.fields,
        transferredAt,
        extraction: (row.extracted as InstapayReceiptExtraction | null) ?? null,
        extractionStatus: row.extractionStatus,
        expectedAmountMinor: args.expectedAmountMinor,
        expectedReceivers: args.expectedReceivers,
        notBefore: args.notBefore,
        notBeforeFlag: 'DATE_BEFORE_ORDER',
        sameImageSeenBefore: sameImage > 0,
        now,
      });
      const claim = await claimInstapayReference(referenceKey, storeId, receiptId);
      if (claim === 'taken') {
        throw new AppError(
          409,
          'DUPLICATE_REFERENCE',
          'This transfer reference was already used. Each transfer can pay only once.'
        );
      }
      try {
        const out = await money.receiptSubmit({
          orderId,
          receiptId,
          fields: {
            amountMinor: args.fields.amountMinor,
            reference: args.fields.reference,
            transferredAt: transferredAt.getTime(),
            payerName: args.fields.payerName ?? null,
            payerAddress: args.fields.payerAddress ?? null,
            payerMobile: args.fields.payerMobile ?? null,
            payerBank: args.fields.payerBank ?? null,
            receiverName: args.fields.receiverName ?? null,
            receiverHandle: args.fields.receiverHandle ?? null,
            receiverMobile: args.fields.receiverMobile ?? null,
            note: args.fields.note ?? null,
          },
          referenceKey,
          flags,
          extractionStatus: row.extractionStatus,
          expectedAmountMinor: args.expectedAmountMinor,
          expectedReceiver: args.expectedReceivers.filter(Boolean).join(' / ') || null,
        });
        return receiptFromDo(out);
      } catch (err) {
        // The claim this call made is freed only when the DO ANSWERED with a refusal (its section rolled back, so this receipt
        // is not submitted) and the refusal is not DUPLICATE_REFERENCE (another receipt holds the key). A transport error
        // leaves the outcome unknown (the section may have committed): the claim stays, fail closed.
        const code = (err as { code?: string }).code;
        if (claim === 'claimed' && err instanceof AppError && code !== 'DUPLICATE_REFERENCE')
          await releaseInstapayReference(referenceKey, storeId, receiptId);
        // the AI read landed between the read and the submit: recompute the flags once
        if ((err as { code?: string }).code === 'RECEIPT_CHANGED' && attempt === 0) continue;
        throw err;
      }
    }
  }

  /** The merchant rejects a submitted ORDER receipt of a DO store: the reference is freed, the hold restarts (one DO section). */
  static async rejectOnDo(args: {
    storeId: string;
    orderId: string;
    receiptId: string;
    note: string;
    actorUserId: string;
  }): Promise<{ receiptId: string; status: 'rejected'; expiresAt: string } | null> {
    const money = await storeMoney(args.storeId);
    if (!money) return null;
    const r = await money.receiptReject({
      orderId: args.orderId,
      receiptId: args.receiptId,
      note: args.note,
      actorId: args.actorUserId,
    });
    if (r.referenceKey)
      await releaseInstapayReference(r.referenceKey, args.storeId, args.receiptId);
    return {
      receiptId: r.receiptId,
      status: 'rejected',
      expiresAt: new Date(r.expiresAt).toISOString(),
    };
  }

  /** Approver decision on a submitted receipt (called from the money paths, same transaction). */
  static async markReviewed(
    storeId: string,
    receiptId: string,
    decision: { status: 'approved' } | { status: 'rejected'; note: string },
    actorId: string | null,
    now: Date = new Date()
  ): Promise<number> {
    const freed =
      decision.status === 'rejected'
        ? await prisma.instapayReceipt.findMany({
            where: { id: receiptId, storeId, status: 'submitted', referenceKey: { not: null } },
            select: { id: true, referenceKey: true },
          })
        : [];
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
    if (count > 0) freeClaimsAfterCommit(storeId, freed);
    return count;
  }

  /**
   * A human approved the payment: mark the submitted receipts approved and return their ids so the CALLER deletes the
   * screenshots AFTER its transaction commits (`deleteImages`). Two callers: the merchant's confirm of an order payment
   * (all the order's submitted receipts) and the super-admin's recorded manual payment (the receipts of the claims it settles).
   */
  static async approveSubmitted(
    tx: Prisma.TransactionClient,
    storeId: string,
    where: { orderId: string } | { claimIds: string[] },
    actorId: string | null,
    now: Date
  ): Promise<string[]> {
    const scope =
      'orderId' in where
        ? { storeId, kind: 'order', orderId: where.orderId, status: 'submitted' }
        : { storeId, claimId: { in: where.claimIds }, status: 'submitted' };
    const rows = await tx.instapayReceipt.findMany({ where: scope, select: { id: true } });
    if (rows.length === 0) return [];
    await tx.instapayReceipt.updateMany({
      where: { ...scope, id: { in: rows.map(r => r.id) } },
      data: { status: 'approved', reviewedBy: actorId, reviewedAt: now },
    });
    return rows.map(r => r.id);
  }

  /** After the approving transaction committed: delete the screenshots (each failure is retried by the retention sweep). */
  static async deleteImages(storeId: string, receiptIds: string[]): Promise<void> {
    for (const id of receiptIds) await this.deleteImage(storeId, id);
  }

  /** Delete the stored screenshot (idempotent) and record it. Never throws: the retention sweep retries a miss. */
  static async deleteImage(storeId: string, receiptId: string): Promise<boolean> {
    try {
      // an order receipt of a DO store: the object goes, then the row records it (both idempotent)
      const money = await storeMoney(storeId);
      if (money) {
        const mine = await money.receiptGet({ receiptId }).then(
          r => r,
          (e: { code?: string }) => {
            if (e?.code === 'RECEIPT_NOT_FOUND') return null;
            throw e;
          }
        );
        if (mine) {
          if (mine.imageDeletedAt) return false;
          await StorageService.deletePrivate(mine.storageKey);
          await money.receiptImageDeleted({ receiptId });
          return true;
        }
      }
      const row = await withStore(storeId, () =>
        prisma.instapayReceipt.findUnique({
          where: { id: receiptId, storeId },
          select: { storageKey: true, imageDeletedAt: true },
        })
      );
      if (!row || row.imageDeletedAt) return false;
      await StorageService.deletePrivate(row.storageKey);
      await withStore(storeId, () =>
        prisma.instapayReceipt.updateMany({
          where: { id: receiptId, storeId, imageDeletedAt: null },
          data: { imageDeletedAt: new Date() },
        })
      );
      return true;
    } catch (err) {
      logger.warn(
        { err, storeId, receiptId },
        '[instapay-receipt] image delete failed; the retention sweep retries'
      );
      return false;
    }
  }

  /**
   * Retention (M-025), run by the weekly data-retention job:
   *  - screenshots: approved and not yet deleted (a missed post-commit delete) -> deleted; rejected / voided 30 days after
   *    the decision; drafts and failed uploads 30 days after creation. Each is recorded in `image_deleted_at`.
   *  - personal fields (payer / receiver / note / the AI-read JSON): scrubbed 180 days after a final decision
   *    (approved, rejected, voided) and recorded in `personal_scrubbed_at`. The amount, reference, transfer time, flags and
   *    status stay: they are the financial evidence behind the payment, kept with it (docs/RETENTION.md).
   * Idempotent; per store, in the store's own scope.
   */
  static async sweepRetention(
    now: Date = new Date(),
    only?: string
  ): Promise<{ images: number; scrubbed: number }> {
    const day = 86_400_000;
    const imageCut = new Date(now.getTime() - 30 * day);
    const personalCut = new Date(now.getTime() - 180 * day);
    // An ALARM run (`only` = the store) sweeps that one store on the backend it lives on; a cron run sweeps the Postgres stores.
    const onlyIsDo = only ? (await storeRepo(only)).backend === 'do' : false;
    const parts = onlyIsDo
      ? []
      : await acrossStores(
          async storeId => {
            const imgs = await prisma.instapayReceipt.findMany({
              where: {
                storeId,
                imageDeletedAt: null,
                OR: [
                  { status: 'approved' },
                  { status: { in: ['rejected', 'voided'] }, reviewedAt: { lt: imageCut } },
                  { status: 'draft', createdAt: { lt: imageCut } },
                  // proof nobody ever decided on (an order cancelled outside confirm / reject, a claim left pending)
                  { status: 'submitted', submittedAt: { lt: new Date(now.getTime() - 90 * day) } },
                  // an erasure scrubbed it but its immediate delete missed (the delete runs after the erasure commits)
                  { personalScrubbedAt: { not: null } },
                ],
              },
              select: { id: true },
              take: 500,
            });
            let images = 0;
            for (const r of imgs) if (await this.deleteImage(storeId, r.id)) images++;
            const scrub = await prisma.instapayReceipt.updateMany({
              where: {
                storeId,
                personalScrubbedAt: null,
                OR: [
                  {
                    status: { in: ['approved', 'rejected', 'voided'] },
                    reviewedAt: { lt: personalCut },
                  },
                  { status: 'submitted', submittedAt: { lt: personalCut } },
                ],
              },
              data: SCRUBBED_PERSONAL_FIELDS(now),
            });
            return { images, scrubbed: scrub.count };
          },
          {
            onStoreError: (storeId, err) =>
              logger.error({ err, storeId }, '[instapay-receipt] retention failed'),
            ...(only ? { storeIds: [only] } : {}),
          }
        );
    const total = parts.reduce(
      (a, p) => ({ images: a.images + p.value.images, scrubbed: a.scrubbed + p.value.scrubbed }),
      { images: 0, scrubbed: 0 }
    );
    // stores on their Durable Object: `acrossStores` skips them, their receipts are swept in the DO (Ruling INSTAPAY-DO-1)
    // With jobs on the DO, a DO store's own alarm sweeps it (Ruling CF-JOBS-4B); without, the cron still covers it from here.
    const doStores = only ? (onlyIsDo ? [only] : []) : jobsOnDo() ? [] : await doStoreIdList();
    for (const storeId of doStores) {
      try {
        const money = await storeMoney(storeId);
        if (!money) continue;
        const r = await money.receiptSweep();
        total.scrubbed += r.scrubbed;
        for (const d of r.dueImages) if (await this.deleteImage(storeId, d.id)) total.images++;
      } catch (err) {
        logger.error({ err, storeId }, '[instapay-receipt] retention failed (durable object)');
      }
    }
    return total;
  }

  /**
   * The shopper's erasure: the receipts attached to the given orders lose their personal fields and their screenshot
   * (the amount, reference and status stay with the order's financial record). Runs inside the erasure transaction;
   * the object deletes happen after it commits.
   */
  static async scrubForOrders(
    tx: Prisma.TransactionClient,
    storeId: string,
    orderIds: string[]
  ): Promise<number> {
    if (orderIds.length === 0) return 0;
    const rows = await tx.instapayReceipt.findMany({
      where: { storeId, orderId: { in: orderIds }, kind: 'order' },
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await tx.instapayReceipt.updateMany({
      where: { storeId, id: { in: rows.map(r => r.id) } },
      data: SCRUBBED_PERSONAL_FIELDS(new Date()),
    });
    // The screenshots are NOT deleted here: this runs inside the erasure transaction, and an object delete before its
    // commit would lose the evidence if the erasure rolls back (and race the commit). The rows are marked
    // (`personal_scrubbed_at`) and the next retention sweep deletes their images.
    return res.count;
  }

  /** Free a (approved) receipt's reference after its payment was VOIDED (recorded in error). */
  static async voidByClaim(
    storeId: string,
    claimId: string,
    note: string,
    actorId: string,
    opts: { keepReference?: boolean } = {}
  ) {
    const freed = opts.keepReference
      ? []
      : await prisma.instapayReceipt.findMany({
          where: { storeId, claimId, referenceKey: { not: null } },
          select: { id: true, referenceKey: true },
        });
    const res = await prisma.instapayReceipt.updateMany({
      where: { storeId, claimId },
      data: {
        status: 'voided',
        // INSTAPAY-AUTO-1: a "not received" receipt keeps its reference (and its D1 claim) so it can never be submitted again
        ...(opts.keepReference ? {} : { referenceKey: null }),
        reviewNote: note.slice(0, 500),
        reviewedBy: actorId,
        reviewedAt: new Date(),
      },
    });
    freeClaimsAfterCommit(storeId, freed);
    return res;
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
