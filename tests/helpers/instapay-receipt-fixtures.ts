/**
 * InstaPay receipt fixtures (money batch A): an in-memory private bucket, the
 * RECORDED Gemini answers for the two synthetic receipts in tests/fixtures/instapay,
 * and helpers that walk the real upload -> AI read -> submit path.
 *
 * The images are synthetic (made-up names and numbers, never a real customer's
 * screenshot); the `.gemini.json` files are what gemini-flash-lite-latest answered
 * for them, so tests exercise the real normalisation on a real model's output with
 * no network call.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { vi } from 'vitest';
import type { InstapayReceiptFields } from '@ebda/shared';
import { StorageService } from '@api/services/storage.service';
import { setReceiptModelCallForTests } from '@api/lib/ai/instapay-receipt-reader';
import { InstapayReceiptService } from '@api/services/payment-providers/instapay-receipt.service';
import { submitSubscriptionReceipt } from '@api/services/billing/account.service';

const FIX = path.resolve(__dirname, '../fixtures/instapay');

export type ReceiptLayout = 'receipt-sent' | 'receipt-received';

export const receiptImage = (layout: ReceiptLayout): Buffer =>
  readFileSync(path.join(FIX, `${layout}.png`));

export const recordedGemini = (layout: ReceiptLayout): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(FIX, `${layout}.gemini.json`), 'utf8')).response;

/** A distinct PNG per call (same pixels + a trailing nonce chunk) so SAME_IMAGE stays opt-in. */
export function uniqueImage(layout: ReceiptLayout): Buffer {
  return Buffer.concat([receiptImage(layout), Buffer.from(crypto.randomUUID())]);
}

/** A fresh 12-digit transfer reference (like a real receipt's). */
export const freshReference = (): string =>
  String(Math.floor(1e11 + Math.random() * 9e11)).slice(0, 12);

/** Replace the private bucket with an in-memory map (the real one fails closed in tests). */
export function mockPrivateStorage(): Map<string, { body: Buffer; contentType: string }> {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  vi.spyOn(StorageService, 'putPrivate').mockImplementation(async (buffer, args) => {
    const key = `stores/${args.storeId}/${args.folder}/${crypto.randomUUID()}${args.ext}`;
    objects.set(key, { body: buffer, contentType: args.contentType });
    return { key };
  });
  vi.spyOn(StorageService, 'getPrivate').mockImplementation(async key => {
    const o = objects.get(key);
    if (!o) throw Object.assign(new Error('not found'), { statusCode: 404 });
    return { body: o.body, contentType: o.contentType };
  });
  vi.spyOn(StorageService, 'deletePrivate').mockImplementation(async key => {
    objects.delete(key);
  });
  return objects;
}

/** The model answers with the recorded response for `layout`, with optional overrides. */
export function useRecordedModel(layout: ReceiptLayout, overrides: Record<string, unknown> = {}) {
  setReceiptModelCallForTests(async () => ({ ...recordedGemini(layout), ...overrides }));
}

export function resetModel() {
  setReceiptModelCallForTests(null);
}

/** The fields a payer submits after checking the AI's pre-fill. */
export function fieldsFrom(
  layout: ReceiptLayout,
  over: Partial<InstapayReceiptFields> = {}
): InstapayReceiptFields {
  const r = recordedGemini(layout);
  return {
    amountMinor: Math.round(Number(r.amount) * 100),
    reference: String(r.reference),
    transferDate: String(r.date),
    transferTime: String(r.time),
    payerName: String(r.payerName),
    payerAddress: (r.payerAddress as string) ?? null,
    payerMobile: (r.payerMobile as string) ?? null,
    payerBank: (r.payerBank as string) ?? null,
    receiverName: (r.receiverName as string) ?? null,
    receiverHandle: (r.receiverAddress as string) ?? null,
    receiverMobile: (r.receiverMobile as string) ?? null,
    note: (r.note as string) ?? null,
    ...over,
  };
}

/**
 * The merchant's whole subscription proof path: upload the screenshot, the AI job
 * reads it (recorded answer), submit the checked fields. Returns the claim + receipt.
 */
export async function submitTestSubscriptionReceipt(
  storeId: string,
  over: Partial<InstapayReceiptFields> = {}
) {
  useRecordedModel('receipt-received');
  const uploaded = await InstapayReceiptService.upload({
    storeId,
    kind: 'subscription',
    file: uniqueImage('receipt-received'),
  });
  await InstapayReceiptService.runExtraction(storeId, uploaded.id);
  return submitSubscriptionReceipt({
    storeId,
    receiptId: uploaded.id,
    fields: fieldsFrom('receipt-received', {
      reference: freshReference(),
      transferDate: new Date().toISOString().slice(0, 10),
      transferTime: '00:01',
      ...over,
    }),
  });
}
