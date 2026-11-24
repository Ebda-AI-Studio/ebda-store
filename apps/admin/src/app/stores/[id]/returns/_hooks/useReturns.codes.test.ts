/**
 * Issue 2033 — every 4xx refusal the return-completion path can raise must
 * have its own EN + AR message, not the generic "please try again". Reads the
 * producers directly so a new `throw new AppError(4xx, …)` there goes red here.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import ar from '@/i18n/messages/ar.json';
import { COMPLETE_ERROR_CODES } from './useReturns';

const API = resolve(__dirname, '../../../../../../../api/src/services');
const codes = (src: string) =>
  new Set([...src.matchAll(/AppError\(\s*4\d\d\s*,\s*'([A-Z_]+)'/g)].map(m => m[1]));

// return.service.ts also hosts the CREATE path; these codes are raised only
// there (or are a generic 404), never by complete().
const NOT_ON_COMPLETION = new Set([
  'NOT_FOUND',
  'INVALID_ITEM',
  'INVALID_QUANTITY',
  'INVALID_ORDER',
  'NO_ITEMS',
  'INVALID_BUNDLE_GROUP',
  // The bounded create-path lock (lockOrderReturnsBounded) — complete() takes
  // the blocking lock, so a merchant completion never sees it.
  'RETURN_ORDER_BUSY',
  // Create-path only: the store's published return window has closed / is 0.
  'RETURN_WINDOW_CLOSED',
  // Create-path only (Ruling B5-19): an exchange request that includes a gold-rate line is refused.
  'GOLD_EXCHANGE_UNSUPPORTED',
  // Guest return create path (GUEST-RET-1): the one identical identity-miss answer.
  'GUEST_RETURN_NOT_FOUND',
  // Merchant-opened return / partial refund only (STORE-QA-76): the order's store has no Durable Object, nothing left to refund.
  'RETURNS_NEED_DO_STORE',
  'NOTHING_REFUNDABLE',
]);

describe('return completion refusals are all translated (issue 2033)', () => {
  const factory = readFileSync(resolve(API, 'payment-providers/payment.factory.ts'), 'utf8');
  const refundBody = factory.slice(
    factory.indexOf('static async refund('),
    factory.indexOf('static async handleWebhook(')
  );
  const produced = new Set([
    ...codes(readFileSync(resolve(API, 'return.service.ts'), 'utf8')),
    ...codes(refundBody),
  ]);

  it('reads the producers (control)', () => {
    expect(refundBody.length).toBeGreaterThan(1000);
    expect(produced.has('INVALID_STATE')).toBe(true);
    expect(produced.has('RETURN_ALREADY_COMPLETING')).toBe(true);
  });

  it('every produced completion code is mapped', () => {
    const missing = [...produced].filter(
      c => !NOT_ON_COMPLETION.has(c) && !COMPLETE_ERROR_CODES.has(c)
    );
    expect(missing).toEqual([]);
  });

  it('every mapped code has copy in both locales', () => {
    type Cat = { returns: { messages: { completeErrors: Record<string, string> } } };
    for (const cat of [en, ar] as unknown as Cat[])
      for (const c of COMPLETE_ERROR_CODES)
        expect(cat.returns.messages.completeErrors[c], c).toBeTruthy();
  });
});
