/**
 * Read an InstaPay transfer receipt screenshot with CLOUDFLARE WORKERS AI (vision) - M-003.
 *
 * The screenshot used to go raw to Google Gemini, with a prompt that also asked for the payer's name, mobile, bank and
 * InstaPay address: buyer personal data to a third-party AI processor the privacy text did not name. Now:
 *  - the image is read on Cloudflare Workers AI through the Worker's `AI` binding (no third party beyond the platform
 *    host; nothing is sent to Google);
 *  - the model is asked ONLY for the amount, the reference and the transfer date and time (plus its own confidence and
 *    whether the picture looks edited, which are judgements about the image, not data read from it). Names, mobiles,
 *    banks and InstaPay addresses are never requested, never stored from the model and never shown as its answer;
 *  - the answer only PRE-FILLS the payer's form: the payer corrects it, a human approves it, nothing is decided here;
 *  - the image itself is deleted when the receipt is approved and on the retention schedule
 *    (InstapayReceiptService, docs/RETENTION.md).
 *
 * Every failure (no binding, timeout, quota, bad JSON) is the caller's cue to fall back to manual entry.
 * The model is `INSTAPAY_RECEIPT_AI_MODEL` (default below); real-receipt accuracy is NOT verified here (see Ruling M003-1).
 */
import { z } from 'zod';
import {
  INSTAPAY_RECEIPT_REFERENCE_MAX,
  normalizeInstapayReference,
  toAsciiDigits,
  type InstapayReceiptExtraction,
} from '@ebda/shared';
import { cfBindings } from '../../cf/bindings';
import { assertAiQuota } from '../ai-quota';

export const INSTAPAY_RECEIPT_AI_TIMEOUT_MS = 25_000;
/** A vision-capable Workers AI model with JSON output; override per deployment with INSTAPAY_RECEIPT_AI_MODEL. */
export const INSTAPAY_RECEIPT_AI_MODEL_DEFAULT = '@cf/mistralai/mistral-small-3.1-24b-instruct';

export const INSTAPAY_RECEIPT_PROMPT = `You read ONE screenshot of an Egyptian InstaPay (IPN) money transfer receipt.
The app may be in Arabic or English.
Return ONLY a JSON object with exactly these keys (null when the screenshot does not show the value; never guess):
- "amount": the transferred amount as a number in Egyptian pounds (EGP), e.g. 1200.5. Ignore fees.
- "reference": the transaction reference / reference number exactly as printed (digits only).
- "date": the transfer date as YYYY-MM-DD, as shown on the screen (local Egypt time).
- "time": the transfer time as HH:mm in 24-hour format, as shown on the screen (local Egypt time).
- "looksEdited": true if the image looks edited, pasted together, cropped to hide parts, or not a genuine app screenshot.
- "confidence": a number from 0 to 1 for how sure you are that amount, reference and date are read correctly.
Do not read, copy or return any person's name, phone number, bank, account or InstaPay address.
Convert Arabic-Indic digits to 0-9.`;

/** The JSON shape the model must answer in (Workers AI `response_format`). Only the fields above. */
export const INSTAPAY_RECEIPT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    amount: { type: ['number', 'null'] },
    reference: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    time: { type: ['string', 'null'] },
    looksEdited: { type: 'boolean' },
    confidence: { type: 'number' },
  },
  required: ['amount', 'reference', 'date', 'time'],
  additionalProperties: false,
} as const;

const loose = z
  .object({
    amount: z.union([z.number(), z.string()]).nullable().optional(),
    reference: z.union([z.string(), z.number()]).nullable().optional(),
    date: z.string().nullable().optional(),
    time: z.string().nullable().optional(),
    looksEdited: z.union([z.boolean(), z.string()]).nullable().optional(),
    confidence: z.union([z.number(), z.string()]).nullable().optional(),
  })
  // anything else the model volunteers is dropped on the floor, never stored
  .strip();

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
    // personal fields are never asked of the model and never taken from it (M-003)
    payerName: null,
    payerAddress: null,
    payerMobile: null,
    payerBank: null,
    receiverName: null,
    receiverHandle: null,
    receiverMobile: null,
    note: null,
    direction: 'unknown',
    looksEdited: edited,
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
  };
}

/** Test seam: the one model call, replaced in tests by recorded responses. */
export type ReceiptModelCall = (args: {
  storeId: string;
  imageBase64: string;
  mimeType: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

/** What Workers AI answered, as the JSON object (it returns `{response}`, a chat completion, or the object itself). */
export function unwrapWorkersAiAnswer(out: unknown): unknown {
  const pick = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = /\{[\s\S]*\}/.exec(v);
      if (!m)
        throw Object.assign(new Error('instapay receipt AI answered no JSON'), {
          code: 'AI_BAD_JSON',
        });
      try {
        return JSON.parse(m[0]);
      } catch {
        throw Object.assign(new Error('instapay receipt AI answered malformed JSON'), {
          code: 'AI_BAD_JSON',
        });
      }
    }
    return v;
  };
  const o = out as Record<string, unknown> | null;
  if (o && typeof o === 'object') {
    if ('response' in o) return pick(o.response);
    const choices = o.choices as Array<{ message?: { content?: unknown } }> | undefined;
    if (Array.isArray(choices) && choices[0]?.message) return pick(choices[0].message.content);
    if ('result' in o) return unwrapWorkersAiAnswer(o.result);
  }
  return pick(out);
}

const defaultCall: ReceiptModelCall = async ({ storeId, imageBase64, mimeType, signal }) => {
  const ai = cfBindings()?.AI;
  if (!ai) {
    // Node / local without the binding: manual entry (the payer types three fields).
    throw Object.assign(new Error('Workers AI binding is not available'), {
      code: 'AI_UNAVAILABLE',
    });
  }
  await assertAiQuota({ storeId });
  const override = cfBindings()?.INSTAPAY_RECEIPT_AI_MODEL ?? process.env.INSTAPAY_RECEIPT_AI_MODEL;
  const model =
    (typeof override === 'string' ? override.trim() : '') || INSTAPAY_RECEIPT_AI_MODEL_DEFAULT;
  const out = await ai.run(
    model,
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: INSTAPAY_RECEIPT_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: INSTAPAY_RECEIPT_JSON_SCHEMA },
      max_tokens: 300,
      temperature: 0,
    },
    { signal }
  );
  return unwrapWorkersAiAnswer(out);
};

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
  const ctl = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(Object.assign(new Error('instapay receipt AI timeout'), { code: 'AI_TIMEOUT' }));
    }, timeoutMs);
  });
  try {
    const raw = await Promise.race([
      modelCall({
        storeId: args.storeId,
        imageBase64: args.image.toString('base64'),
        mimeType: args.mimeType,
        signal: ctl.signal,
      }),
      timeout,
    ]);
    return normalizeReceiptExtraction(raw);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
