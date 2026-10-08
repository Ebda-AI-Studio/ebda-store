/**
 * Read an InstaPay transfer receipt screenshot with Gemini (money batch A, Ruling
 * EBDA-MONEYA-2). The answer only PRE-FILLS the payer's form: the payer corrects it,
 * a human approves it, nothing is decided here.
 *
 * Model: the accounting smart layer's `callGemini` (GEMINI_MODEL, default
 * `gemini-flash-lite-latest` — the `*-latest` alias, never a versioned name; it is
 * multimodal) with the key failover client, the platform AI quota and usage
 * recording. Bounded by a timeout; every failure is the caller's cue to fall back to
 * manual entry.
 *
 * Two real layouts exist and both are handled by one prompt: the payer's own "sent"
 * receipt (amount, reference, date/time, the receiver's name + IPA/mobile) and the
 * receiver's "received" notification (the payer's masked name + IPA/mobile).
 */
import { z } from 'zod';
import {
  INSTAPAY_RECEIPT_REFERENCE_MAX,
  normalizeInstapayReference,
  toAsciiDigits,
  type InstapayReceiptExtraction,
} from '@force/shared';
import { callGemini } from '../../services/accounting/gemini-ai.service';

export const INSTAPAY_RECEIPT_AI_TIMEOUT_MS = 25_000;

export const INSTAPAY_RECEIPT_PROMPT = `You read ONE screenshot of an Egyptian InstaPay (IPN) money transfer receipt.
The app may be in Arabic or English. It is either the payer's "sent" receipt or the receiver's "received" notification.
Return ONLY a JSON object with these keys (null when the screenshot does not show the value; never guess):
- "amount": the transferred amount as a number in Egyptian pounds (EGP), e.g. 1200.5. Ignore fees.
- "reference": the transaction reference / reference number exactly as printed (digits only).
- "date": the transfer date as YYYY-MM-DD, as shown on the screen (local Egypt time).
- "time": the transfer time as HH:mm in 24-hour format, as shown on the screen (local Egypt time).
- "payerName": the SENDER's name EXACTLY as shown, keeping any * masking and the original script (Arabic or Latin).
- "payerAddress": the sender's InstaPay address (looks like name@instapay or name@bank), as shown.
- "payerMobile": the sender's mobile number as shown (may be partly masked).
- "payerBank": the sender's bank as shown (e.g. CIB, NBE, Banque Misr).
- "receiverName": the RECEIVER's name exactly as shown.
- "receiverAddress": the receiver's InstaPay address, as shown.
- "receiverMobile": the receiver's mobile number as shown.
- "note": any transfer note / description text.
- "direction": "sent" if this is the sender's receipt, "received" if it is the receiver's notification, else "unknown".
- "looksEdited": true if the image looks edited, pasted together, cropped to hide parts, or not a genuine app screenshot.
- "confidence": a number from 0 to 1 for how sure you are that amount, reference and date are read correctly.
Convert Arabic-Indic digits to 0-9.`;

const loose = z
  .object({
    amount: z.union([z.number(), z.string()]).nullable().optional(),
    reference: z.union([z.string(), z.number()]).nullable().optional(),
    date: z.string().nullable().optional(),
    time: z.string().nullable().optional(),
    payerName: z.string().nullable().optional(),
    payerAddress: z.string().nullable().optional(),
    payerMobile: z.union([z.string(), z.number()]).nullable().optional(),
    payerBank: z.string().nullable().optional(),
    receiverName: z.string().nullable().optional(),
    receiverAddress: z.string().nullable().optional(),
    receiverMobile: z.union([z.string(), z.number()]).nullable().optional(),
    note: z.string().nullable().optional(),
    direction: z.string().nullable().optional(),
    looksEdited: z.union([z.boolean(), z.string()]).nullable().optional(),
    confidence: z.union([z.number(), z.string()]).nullable().optional(),
  })
  .passthrough();

const text = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** EGP amount (number or "1,200.50" / "١٬٢٠٠") to piastres; null when unreadable. */
export function amountToMinor(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const raw = typeof v === 'number' ? String(v) : toAsciiDigits(String(v));
  const cleaned = raw
    .replace(/[٬,\s]/g, '')
    .replace('٫', '.')
    .replace(/[^\d.]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const minor = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

function isoDate(v: unknown): string | null {
  const s = text(v, 20);
  if (!s) return null;
  const d = toAsciiDigits(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) ?? null;
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(d);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return null;
}

function hhmm(v: unknown): string | null {
  const s = text(v, 20);
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|ص|م)?$/i.exec(toAsciiDigits(s));
  if (!m) return null;
  let h = Number(m[1]);
  const suffix = m[3]?.toLowerCase();
  if (suffix === 'pm' || suffix === 'م') h = h % 12 === 0 ? 12 : (h % 12) + 12;
  if (suffix === 'am' || suffix === 'ص') h = h % 12;
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** Normalise whatever the model answered into the stored extraction (pure; unit-tested). */
export function normalizeReceiptExtraction(raw: unknown): InstapayReceiptExtraction {
  const p = loose.safeParse(raw);
  const r = p.success ? p.data : {};
  const referenceRaw = text(r.reference, INSTAPAY_RECEIPT_REFERENCE_MAX * 2);
  const conf = Number(r.confidence);
  const edited = r.looksEdited === true || String(r.looksEdited).toLowerCase() === 'true';
  return {
    amountMinor: amountToMinor(r.amount),
    reference: normalizeInstapayReference(referenceRaw) ?? (referenceRaw ? referenceRaw : null),
    transferDate: isoDate(r.date),
    transferTime: hhmm(r.time),
    payerName: text(r.payerName, 120),
    payerAddress: text(r.payerAddress, 100),
    payerMobile: text(r.payerMobile, 30),
    payerBank: text(r.payerBank, 60),
    receiverName: text(r.receiverName, 120),
    receiverHandle: text(r.receiverAddress, 100),
    receiverMobile: text(r.receiverMobile, 30),
    note: text(r.note, 300),
    direction: r.direction === 'sent' || r.direction === 'received' ? r.direction : 'unknown',
    looksEdited: edited,
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
  };
}

/** Test seam: the one Gemini call, replaced in tests by recorded responses. */
export type ReceiptModelCall = (args: {
  storeId: string;
  imageBase64: string;
  mimeType: string;
}) => Promise<unknown>;

const defaultCall: ReceiptModelCall = ({ storeId, imageBase64, mimeType }) =>
  callGemini<unknown>({
    prompt: INSTAPAY_RECEIPT_PROMPT,
    feature: 'instapay-receipt',
    storeId,
    imageBase64,
    imageMimeType: mimeType,
  });

let modelCall: ReceiptModelCall = defaultCall;
export function setReceiptModelCallForTests(fn: ReceiptModelCall | null): void {
  modelCall = fn ?? defaultCall;
}

/** Read one receipt. Throws on timeout / AI failure (the caller falls back to manual entry). */
export async function readInstapayReceipt(args: {
  storeId: string;
  image: Buffer;
  mimeType: string;
  timeoutMs?: number;
}): Promise<InstapayReceiptExtraction> {
  const timeoutMs = args.timeoutMs ?? INSTAPAY_RECEIPT_AI_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('instapay receipt AI timeout'), { code: 'AI_TIMEOUT' })),
      timeoutMs
    );
  });
  try {
    const raw = await Promise.race([
      modelCall({
        storeId: args.storeId,
        imageBase64: args.image.toString('base64'),
        mimeType: args.mimeType,
      }),
      timeout,
    ]);
    return normalizeReceiptExtraction(raw);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
