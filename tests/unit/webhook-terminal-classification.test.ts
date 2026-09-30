/**
 * PR 2279 scoped-audit P1: a 409 AMBIGUOUS_PAYMENT from handleWebhook was
 * classified as a terminal 4xx, so the inbox row went to 'rejected' with a
 * warn — no retry, no dead-letter P0, and the stuck sweep skips 'rejected'.
 */
import { describe, it, expect } from 'vitest';
import { isTerminalWebhookClientError } from '@api/lib/inngest/webhook-offload.guard';

const err = (statusCode: number, code: string) => ({ statusCode, code });

describe('isTerminalWebhookClientError', () => {
  it('AMBIGUOUS_PAYMENT is NOT terminal — it retries and dead-letters into the P0 path', () => {
    expect(isTerminalWebhookClientError(err(409, 'AMBIGUOUS_PAYMENT'))).toBe(false);
  });

  it.each([
    [400, 'INVALID_SIGNATURE'],
    [400, 'STORE_MISMATCH'],
    [422, 'VALIDATION_ERROR'],
  ])('%s %s (bad bytes) stays terminal — no retry, no P0 an attacker could spam', (s, c) => {
    expect(isTerminalWebhookClientError(err(s, c))).toBe(true);
  });

  it('5xx and non-AppError failures are not terminal', () => {
    expect(isTerminalWebhookClientError(err(500, 'INTERNAL'))).toBe(false);
    expect(isTerminalWebhookClientError(new Error('db down'))).toBe(false);
    expect(isTerminalWebhookClientError(null)).toBe(false);
  });
});
