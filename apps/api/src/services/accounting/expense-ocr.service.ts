/**
 * Expense receipt OCR via Gemini Vision (Batch 3 — Task 6).
 *
 * Fetches an image from a public R2 URL, encodes it to base64, calls
 * Gemini Vision to extract structured receipt data, then creates a draft
 * Expense with OCR metadata attached.
 *
 * Supported formats: .jpg / .jpeg / .png / .webp
 * Unsupported formats: Expense is created as draft with a skip note.
 * Gemini errors: Expense is still created as draft with a failure note so the
 *   uploaded receipt is never silently lost.
 */

import https from 'https';
import http from 'http';
import { prisma } from '@ebda/database';
import logger from '../../lib/logger';
import { callGemini } from './gemini-ai.service';
import { createExpense } from './expense.service';
import { storeRepo } from '../../lib/repo-factory';
import { getSystemAccountIdByCode } from './account.service';

import { REGION, roundToMinor } from '@ebda/shared';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OcrReceiptResult {
  vendor: string | null;
  vendorAr: string | null;
  invoiceDate: string | null; // ISO 8601 date string
  currency: string; // 3-letter code, default EGP
  subtotal: number | null;
  taxAmount: number | null;
  total: number | null;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }>;
  category: string; // one of the expense category slugs
  confidence: number; // 0..1
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const CATEGORY_TO_COA: Record<string, string> = {
  packaging: '5100',
  marketing: '5200',
  salaries: '5300',
  rent: '5400',
  utilities: '5500',
  software: '5600',
  courier: '5700',
  bank_fees: '5800',
  office_supplies: '5990',
  professional_services: '5990',
  other: '5990',
};

const OCR_PROMPT = `You are a receipt parser for an Egypt retailer. Extract the following fields from the attached receipt image:

- vendor (English name or transliteration)
- vendorAr (Arabic vendor name if visible, otherwise null)
- invoiceDate (ISO 8601 date string, e.g. "2026-05-20", or null if not found)
- currency (3-letter ISO code; default to "EGP" if not explicitly shown)
- subtotal (numeric amount before tax, or null if not found)
- taxAmount (numeric tax amount, or null if not found)
- total (final numeric total, or null if not found)
- lineItems: array of { description, quantity, unitPrice, lineTotal } — extract as many as visible
- category: one of exactly these values: packaging, marketing, salaries, rent, utilities, software, courier, bank_fees, office_supplies, professional_services, other
- confidence: float 0..1 representing your confidence in the extraction

Return STRICT JSON with this exact shape:
{ "vendor": string|null, "vendorAr": string|null, "invoiceDate": string|null, "currency": string, "subtotal": number|null, "taxAmount": number|null, "total": number|null, "lineItems": [], "category": string, "confidence": number }`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect MIME type from URL extension. Returns null for unsupported types. */
function detectMime(url: string): string | null {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_MIME[ext] ?? null;
}

/** Fetch a URL and return the body as a Buffer. Handles http + https. */
function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https://') ? https : http;
    lib
      .get(url, res => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} fetching receipt image`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/** Convert a decimal amount (OCR'd from a receipt) → integer minor units of `currency`. */
function toFils(amount: number | null | undefined, currency: string): number {
  if (amount == null || !isFinite(amount)) return 0;
  return roundToMinor(amount, currency);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface ProcessExpenseReceiptArgs {
  storeId: string;
  receiptUrl: string;
  uploadedBy?: string;
}

export async function processExpenseReceipt(
  args: ProcessExpenseReceiptArgs
): Promise<{ expenseId: string }> {
  const { storeId, receiptUrl, uploadedBy } = args;

  // ── 1. Validate MIME ──────────────────────────────────────────────────────
  const imageMimeType = detectMime(receiptUrl);
  if (!imageMimeType) {
    logger.warn({ storeId, receiptUrl }, 'expense-ocr: unsupported image format — creating draft');
    const exp = await createExpense({
      storeId,
      expenseAccountId: await getSystemAccountIdByCode(storeId, '5990').catch(() =>
        _placeholderAccountId()
      ),
      paidFromAccountId: await getSystemAccountIdByCode(storeId, '1000').catch(() =>
        _placeholderAccountId()
      ),
      amount: 0,
      expenseDate: new Date(),
      receiptImageUrl: receiptUrl,
      notes: 'OCR skipped — unsupported format',
      createdBy: uploadedBy,
    });
    return { expenseId: exp.id };
  }

  // ── 2. Fetch image ────────────────────────────────────────────────────────
  let imageBase64: string;
  try {
    const buffer = await fetchBuffer(receiptUrl);
    imageBase64 = buffer.toString('base64');
  } catch (fetchErr) {
    logger.error({ err: fetchErr, storeId, receiptUrl }, 'expense-ocr: failed to fetch image');
    return _createFailedDraft(
      storeId,
      receiptUrl,
      uploadedBy,
      'OCR failed — could not fetch image. Please enter manually.'
    );
  }

  // ── 3. Call Gemini Vision ─────────────────────────────────────────────────
  let parsed: OcrReceiptResult;
  try {
    parsed = await callGemini<OcrReceiptResult>({
      prompt: OCR_PROMPT,
      feature: 'expense-ocr',
      storeId,
      imageBase64,
      imageMimeType,
    });
  } catch (ocrErr) {
    logger.error({ err: ocrErr, storeId, receiptUrl }, 'expense-ocr: gemini call failed');
    return _createFailedDraft(
      storeId,
      receiptUrl,
      uploadedBy,
      'OCR failed — please enter manually'
    );
  }

  // ── 4. Map category → COA code ────────────────────────────────────────────
  const coaCode = CATEGORY_TO_COA[parsed.category ?? ''] ?? '5990';

  // ── 5. Resolve account IDs ────────────────────────────────────────────────
  let expenseAccountId: string;
  let paidFromAccountId: string;
  try {
    [expenseAccountId, paidFromAccountId] = await Promise.all([
      getSystemAccountIdByCode(storeId, coaCode),
      getSystemAccountIdByCode(storeId, '1000'), // Cash Online
    ]);
  } catch (acctErr) {
    logger.error({ err: acctErr, storeId, coaCode }, 'expense-ocr: account lookup failed');
    return _createFailedDraft(
      storeId,
      receiptUrl,
      uploadedBy,
      'OCR failed — COA accounts not seeded. Please enter manually.'
    );
  }

  // ── 6. Convert amounts to piastres ────────────────────────────────────────────
  const currency = parsed.currency || REGION.currency;
  // ACCT-AUDIT-2: `total` is the GROSS receipt amount (tax included) and createExpense adds `taxAmount` on top of `amount`,
  // so the amount stored is the NET: total - tax. A receipt with only a subtotal already is net. A tax larger than the
  // total is a misread, so it is dropped rather than turned into a negative net.
  const grossFils = parsed.total != null ? toFils(parsed.total, currency) : null;
  let taxFils = toFils(parsed.taxAmount, currency);
  if (grossFils != null && taxFils > grossFils) taxFils = 0;
  const amountFils = grossFils != null ? grossFils - taxFils : toFils(parsed.subtotal, currency);

  const nonBaseNote =
    currency !== REGION.currency
      ? ` Non-EGP receipt (${currency}). FX rate stored as 1 (placeholder). Please set the correct rate before approving.`
      : '';

  const notes = [
    `Auto-parsed from receipt. Vendor: ${parsed.vendor ?? 'unknown'}. Currency: ${currency}.`,
    nonBaseNote,
  ]
    .join('')
    .trim();

  // ── 7. Create draft Expense ───────────────────────────────────────────────
  // For non-EGP OCR receipts we don't know the day's FX rate — store the raw
  // foreign-currency amount as `originalAmount` and fxRate=1 as a placeholder.
  // The merchant must set the correct fxRate in the expense edit UI before
  // approving, which will re-compute the EGP amount.
  // A store on its Durable Object stores the OCR metadata in the draft's own atomic section (Ruling CF-JOBS-4B)
  const onDo = (await storeRepo(storeId)).backend === 'do';
  const ocrModelVersion = process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest';
  let exp;
  try {
    exp = await createExpense({
      storeId,
      expenseAccountId,
      paidFromAccountId,
      amount: amountFils,
      taxAmount: taxFils,
      expenseDate: parsed.invoiceDate ? new Date(parsed.invoiceDate) : new Date(),
      currency,
      // fxRate omitted for non-EGP (stored as 1 placeholder): merchant reviews before posting
      receiptImageUrl: receiptUrl,
      notes,
      createdBy: uploadedBy,
      ...(onDo
        ? {
            ocr: {
              json: parsed,
              confidence: parsed.confidence ?? null,
              modelVersion: ocrModelVersion,
              processedAtMs: Date.now(),
            },
          }
        : {}),
    });
  } catch (createErr) {
    logger.error({ err: createErr, storeId }, 'expense-ocr: createExpense failed');
    throw createErr; // let Inngest retry
  }

  // ── 8. Attach OCR metadata ────────────────────────────────────────────────
  try {
    if (!onDo)
      await prisma.expense.update({
        where: { id: exp.id, storeId },
        data: {
          ocrJson: parsed as any,
          categoryAiConfidence: parsed.confidence ?? null,
          ocrModelVersion,
          ocrProcessedAt: new Date(),
        },
      });
  } catch (metaErr) {
    // Non-fatal: draft was created, OCR metadata just isn't attached
    logger.warn({ err: metaErr, expenseId: exp.id }, 'expense-ocr: failed to attach ocr metadata');
  }

  logger.info({ storeId, expenseId: exp.id, vendor: parsed.vendor }, 'expense-ocr: done');
  return { expenseId: exp.id };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Create a minimal draft expense when OCR is skipped or fails. */
async function _createFailedDraft(
  storeId: string,
  receiptUrl: string,
  uploadedBy: string | undefined,
  notes: string
): Promise<{ expenseId: string }> {
  try {
    const [expenseAccountId, paidFromAccountId] = await Promise.all([
      getSystemAccountIdByCode(storeId, '5990'),
      getSystemAccountIdByCode(storeId, '1000'),
    ]);
    const exp = await createExpense({
      storeId,
      expenseAccountId,
      paidFromAccountId,
      amount: 0,
      expenseDate: new Date(),
      receiptImageUrl: receiptUrl,
      notes,
      createdBy: uploadedBy,
    });
    return { expenseId: exp.id };
  } catch (err) {
    logger.error({ err, storeId, receiptUrl }, 'expense-ocr: _createFailedDraft also failed');
    throw err;
  }
}

/** Sentinel: return empty string to satisfy type — callers catch this before using it. */
function _placeholderAccountId(): string {
  return '';
}
