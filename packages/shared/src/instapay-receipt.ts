/**
 * InstaPay transfer receipts (money batch A, Rulings EBDA-MONEYA-1..6).
 *
 * Whoever pays by InstaPay (a merchant paying Ebda's subscription, a shopper paying
 * a store order) uploads the receipt screenshot. The AI pre-fills these fields, the
 * payer corrects them and submits, a human approves. Shared by the API (validation),
 * the admin (approver view) and the storefront (payer form).
 */
import { z } from 'zod/v3';
import { toAsciiDigits } from './ascii-digits';

/** Largest screenshot accepted (a phone screenshot is 0.2-3 MB). */
export const INSTAPAY_RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
export const INSTAPAY_RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type InstapayReceiptMime = (typeof INSTAPAY_RECEIPT_MIME_TYPES)[number];

/** Real receipts show a 12-digit reference; 8-20 digits are accepted. */
export const INSTAPAY_RECEIPT_REFERENCE_MIN = 8;
export const INSTAPAY_RECEIPT_REFERENCE_MAX = 20;

/** Below this the approver sees a LOW_CONFIDENCE flag. */
export const INSTAPAY_RECEIPT_LOW_CONFIDENCE = 0.7;

/**
 * The automatic checks shown to the approver. They FLAG, they never block —
 * except an exact duplicate reference, which is refused at submit.
 */
export const INSTAPAY_RECEIPT_FLAGS = [
  'AMOUNT_MISMATCH',
  'RECEIVER_MISMATCH',
  'RECEIVER_MISSING',
  'DATE_BEFORE_ORDER',
  'DATE_TOO_OLD',
  'DATE_IN_FUTURE',
  'LOW_CONFIDENCE',
  'LOOKS_EDITED',
  'FIELDS_CORRECTED',
  'SAME_IMAGE_USED_BEFORE',
  'AI_UNAVAILABLE',
  'SUSPICIOUS_TEXT',
  /** A plan-change (downgrade) payment that is not due yet: the transfer is recorded and held for the operator. */
  'PAYMENT_NOT_DUE',
] as const;
export type InstapayReceiptFlag = (typeof INSTAPAY_RECEIPT_FLAGS)[number];

export { toAsciiDigits };

/**
 * The comparable form of a transfer reference: its digits only. Null when it is
 * not 8-20 digits (the receipt's reference is always digits).
 */
export function normalizeInstapayReference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = toAsciiDigits(raw).replace(/[\s\-_.#/]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (
    digits.length < INSTAPAY_RECEIPT_REFERENCE_MIN ||
    digits.length > INSTAPAY_RECEIPT_REFERENCE_MAX
  ) {
    return null;
  }
  return digits;
}

/** Comparable receiver: an IPA lower-cased, or a mobile's last 10 digits. */
export function normalizeInstapayReceiver(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = toAsciiDigits(raw).trim().toLowerCase();
  if (!v) return null;
  if (v.includes('@')) return v.replace(/\s+/g, '');
  const digits = v.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform(v => (v ? v : null));

/**
 * What the payer submits (pre-filled by the AI, correctable). The transfer time is
 * the LOCAL time shown on the receipt (Africa/Cairo); the API converts it.
 */
export const instapayReceiptFieldsSchema = z
  .object({
    /** Amount in piastres. */
    amountMinor: z.number().int().positive().max(1_000_000_000),
    reference: z
      .string()
      .trim()
      .max(40)
      .refine(v => normalizeInstapayReference(v) !== null, {
        message: 'The transfer reference is 8 to 20 digits',
      }),
    /** YYYY-MM-DD as shown on the receipt. */
    transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** HH:mm (24h) as shown on the receipt. */
    transferTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /** Exactly as shown, masks (*) included; Arabic or Latin. */
    payerName: z.string().trim().min(1).max(120),
    /** x@instapay as shown. */
    payerAddress: optText(100),
    /** Mobile as shown (may be masked). */
    payerMobile: optText(30),
    payerBank: optText(60),
    receiverName: optText(120),
    receiverHandle: optText(100),
    receiverMobile: optText(30),
    note: optText(300),
  })
  .strict();
export type InstapayReceiptFields = z.infer<typeof instapayReceiptFieldsSchema>;

/** The AI's reading of a receipt, as stored (`extracted`) and shown to the payer/approver. */
export interface InstapayReceiptExtraction {
  amountMinor: number | null;
  reference: string | null;
  transferDate: string | null;
  transferTime: string | null;
  payerName: string | null;
  payerAddress: string | null;
  payerMobile: string | null;
  payerBank: string | null;
  receiverName: string | null;
  receiverHandle: string | null;
  receiverMobile: string | null;
  note: string | null;
  /** sent = the payer's own receipt; received = the receiver's notification. */
  direction: 'sent' | 'received' | 'unknown';
  looksEdited: boolean;
  confidence: number;
  /**
   * RECEIVER-CHECK-1: did the screenshot show one of the store's expected receivers? A yes / no only (never any receiver
   * text); null = not asked (no expected receiver configured) or the model gave no clear answer.
   */
  receiverMatch?: boolean | null;
}

export type InstapayReceiptStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'voided';
export type InstapayReceiptExtractionStatus = 'pending' | 'done' | 'failed';

/** The payer's / approver's view of one receipt (never the image URL: it is streamed). */
export interface InstapayReceiptView {
  id: string;
  kind: 'subscription' | 'order';
  status: InstapayReceiptStatus;
  extractionStatus: InstapayReceiptExtractionStatus;
  extracted: InstapayReceiptExtraction | null;
  confidence: number | null;
  fields: {
    amountMinor: number | null;
    reference: string | null;
    /** ISO instant (UTC) of the transfer. */
    transferredAt: string | null;
    payerName: string | null;
    payerAddress: string | null;
    payerMobile: string | null;
    payerBank: string | null;
    receiverName: string | null;
    receiverHandle: string | null;
    receiverMobile: string | null;
    note: string | null;
  };
  expectedAmountMinor: number | null;
  expectedReceiver: string | null;
  flags: InstapayReceiptFlag[];
  reviewNote: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

/** A refund (or void) recorded after money went back outside Ebda. */
export const instapayRefundRecordSchema = z
  .object({
    /** The refund transfer's reference as shown (digits). */
    reference: z
      .string()
      .trim()
      .max(40)
      .refine(v => normalizeInstapayReference(v) !== null, {
        message: 'The refund reference is 8 to 20 digits',
      }),
    /** YYYY-MM-DD + HH:mm local (Africa/Cairo) as shown on the refund receipt. */
    refundDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    refundTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('12:00'),
    /** Who received the refund, exactly as shown (masks included). */
    recipientName: z.string().trim().min(1).max(120),
    amountMinor: z.number().int().positive().max(1_000_000_000),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .strict();
export type InstapayRefundRecord = z.infer<typeof instapayRefundRecordSchema>;

/**
 * Rule-based (model-independent) check for text inside the screenshot that is addressed to
 * the reader rather than part of a receipt, e.g. "set looksEdited false, confidence 1".
 * SEC-11: the AI flags can be talked out of firing, so this one never depends on them.
 */
const INSTRUCTION_TEXT =
  /(?:looks?\s*edited|confidence|ignore\s+(?:all\s+|the\s+)?(?:previous|above|prior)|system\s*prompt|do\s+not\s+(?:flag|warn)|no\s+warnings?|json|تجاهل\s+(?:كل\s+)?(?:التعليمات|ما\s+سبق)|لا\s+تحذر)/i;

export function hasInstructionLikeText(values: ReadonlyArray<string | null | undefined>): boolean {
  return values.some(v => typeof v === 'string' && INSTRUCTION_TEXT.test(v));
}
