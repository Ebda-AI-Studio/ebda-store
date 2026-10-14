/**
 * Confirm-token round-trip for destructive merchant-MCP tools (cancel order,
 * delete product, bulk anything): the first call returns a token, the second
 * call must present it unchanged. Binds tool + store + key + the EXACT args
 * confirmed, so a token minted for "cancel order A" cannot execute against
 * order B, another store, or another key — and it expires quickly, matching
 * `review-token.ts`'s derived-secret pattern (ENCRYPTION_KEY, not JWT_SECRET).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const cfg = vi.hoisted(() => ({
  encryptionKey: 'test-encryption-key-0123456789abcdef',
}));
vi.mock('@api/config', () => ({ config: cfg }));

const redisMock = vi.hoisted(() => ({
  available: true,
  set: vi.fn(),
}));
vi.mock('@api/services/redis.service', () => ({
  redis: {
    isAvailable: () => redisMock.available,
    getClient: () => (redisMock.available ? { set: redisMock.set } : null),
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  signConfirmToken,
  verifyConfirmToken,
  consumeConfirmToken,
  hashConfirmArgs,
  CONFIRM_TOKEN_TTL_MS,
} from '@api/mcp/merchant-confirm-token';

const base = {
  tool: 'admin_cancel_order',
  storeId: 'store-1',
  keyId: 'key-1',
  userId: 'user-1',
  argsHash: hashConfirmArgs({ orderId: 'order-1' }),
};

afterEach(() => {
  redisMock.available = true;
  redisMock.set.mockReset();
  cfg.encryptionKey = 'test-encryption-key-0123456789abcdef';
  vi.useRealTimers();
});

describe('merchant MCP confirm token', () => {
  it('round-trips when every field matches', () => {
    const token = signConfirmToken(base);
    expect(verifyConfirmToken(token, base)).toBe(true);
  });

  it('refuses a token for a different tool, store, key, or args', () => {
    const token = signConfirmToken(base);
    expect(verifyConfirmToken(token, { ...base, tool: 'admin_delete_product' })).toBe(false);
    expect(verifyConfirmToken(token, { ...base, storeId: 'store-2' })).toBe(false);
    expect(verifyConfirmToken(token, { ...base, keyId: 'key-2' })).toBe(false);
    expect(verifyConfirmToken(token, { ...base, userId: 'user-2' })).toBe(false);
    expect(
      verifyConfirmToken(token, { ...base, argsHash: hashConfirmArgs({ orderId: 'order-2' }) })
    ).toBe(false);
  });

  it('expires after the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const token = signConfirmToken(base);
    vi.setSystemTime(CONFIRM_TOKEN_TTL_MS + 1);
    expect(verifyConfirmToken(token, base)).toBe(false);
  });

  it('rejects a tampered or malformed token', () => {
    const token = signConfirmToken(base);
    const tampered = token.slice(0, -4) + (token.endsWith('aaaa') ? 'bbbb' : 'aaaa');
    expect(verifyConfirmToken(tampered, base)).toBe(false);
    expect(verifyConfirmToken('not-a-token', base)).toBe(false);
    expect(verifyConfirmToken('', base)).toBe(false);
  });

  it('hashConfirmArgs is order-independent on key order but sensitive to values', () => {
    expect(hashConfirmArgs({ a: 1, b: 2 })).toBe(hashConfirmArgs({ b: 2, a: 1 }));
    expect(hashConfirmArgs({ a: 1, b: 2 })).not.toBe(hashConfirmArgs({ a: 1, b: 3 }));
  });

  it('hashConfirmArgs canonicalizes nested objects at every depth and ignores undefined keys', () => {
    expect(hashConfirmArgs({ p: { b: 1, a: [{ y: 1, x: 2 }] } })).toBe(
      hashConfirmArgs({ p: { a: [{ x: 2, y: 1 }], b: 1 } })
    );
    expect(hashConfirmArgs({ a: 1, b: undefined })).toBe(hashConfirmArgs({ a: 1 }));
    expect(hashConfirmArgs({ p: { a: [1, 2] } })).not.toBe(hashConfirmArgs({ p: { a: [2, 1] } }));
  });

  it('two tokens for the same subject are distinct (random jti)', () => {
    expect(signConfirmToken(base)).not.toBe(signConfirmToken(base));
  });
});

describe('consumeConfirmToken (single use)', () => {
  it('first claim wins (SET NX OK), a replay is refused (NX returns null)', async () => {
    redisMock.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const token = signConfirmToken(base);
    expect(await consumeConfirmToken(token)).toBe(true);
    expect(await consumeConfirmToken(token)).toBe(false);
    expect(redisMock.set).toHaveBeenCalledWith(
      expect.stringMatching(/^mcp:confirm-used:/),
      '1',
      'EX',
      expect.any(Number),
      'NX'
    );
  });

  it('fails CLOSED when the claim store errors', async () => {
    redisMock.set.mockRejectedValue(new Error('boom'));
    await expect(consumeConfirmToken(signConfirmToken(base))).rejects.toThrow(/NOT performed/);
  });

  it('fails CLOSED when no store is available outside the test carve-out', async () => {
    redisMock.available = false;
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(consumeConfirmToken(signConfirmToken(base))).rejects.toThrow(/NOT performed/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('uses the process-local set under NODE_ENV=test when Redis is absent (replay still refused)', async () => {
    redisMock.available = false;
    const token = signConfirmToken(base);
    expect(await consumeConfirmToken(token)).toBe(true);
    expect(await consumeConfirmToken(token)).toBe(false);
  });

  it('a malformed token is never consumed as valid', async () => {
    expect(await consumeConfirmToken('garbage.sig')).toBe(false);
  });
});
