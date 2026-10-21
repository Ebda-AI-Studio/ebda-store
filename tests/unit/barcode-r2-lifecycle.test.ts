import { describe, it, expect } from 'vitest';
import { barcodeObjectKey, isBarcodeObjectKey } from '../../apps/api/src/lib/barcode-png/key';
import {
  isDerivedR2Key,
  isExpiredDerivedKey,
  DERIVED_R2_RETENTION_DAYS,
} from '../../apps/api/src/lib/r2-references';
import { classifyOrphans } from '../../scripts/r2-orphan-audit';

const STORE = '3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d';
const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 21);

describe('barcode object keys', () => {
  it('are store-scoped, non-guessable and carry no order number or PII', () => {
    const k = barcodeObjectKey(
      'secret-a-0123456789012345678901234567',
      STORE,
      'order',
      'ORD-T5JK9Q-AB3XY',
      'palm'
    );
    expect(k).toMatch(new RegExp(`^stores/${STORE}/barcodes/[0-9a-f]{32}\\.png$`));
    expect(k).not.toContain('T5JK9Q');
    expect(isBarcodeObjectKey(k)).toBe(true);
  });
  it('are deterministic per (store, kind, number, shape) and differ across any of them or the secret', () => {
    const s = 'secret-a-0123456789012345678901234567';
    const k = (...a: [string, string, string, string]) => barcodeObjectKey(s, ...a);
    const base = k(STORE, 'order', 'ORD-T5JK9Q-AB3XY', 'palm');
    expect(k(STORE, 'order', 'ORD-T5JK9Q-AB3XY', 'palm')).toBe(base);
    expect(k(STORE, 'order', 'ORD-T5JK9Q-AB3XY', 'plain')).not.toBe(base);
    expect(k(STORE, 'billing', 'ORD-T5JK9Q-AB3XY', 'palm')).not.toBe(base);
    expect(k(STORE, 'order', 'ORD-T5JK9Q-AB3XZ', 'palm')).not.toBe(base);
    expect(
      barcodeObjectKey(
        'secret-b-0123456789012345678901234567',
        STORE,
        'order',
        'ORD-T5JK9Q-AB3XY',
        'palm'
      )
    ).not.toBe(base);
  });
  it('refuses a store id that is not a uuid (no path tricks)', () => {
    expect(() =>
      barcodeObjectKey('secret-a-0123456789012345678901234567', '../x', 'order', 'N', 'plain')
    ).toThrow();
    expect(isBarcodeObjectKey(`stores/${STORE}/barcodes/../../x.png`)).toBe(false);
  });
});

describe('derived R2 objects in the reference registry + orphan sweep', () => {
  const key = barcodeObjectKey(
    'secret-a-0123456789012345678901234567',
    STORE,
    'order',
    'N-1',
    'plain'
  );
  it('are recognised as derived (no DB column references them)', () => {
    expect(isDerivedR2Key(key)).toBe(true);
    expect(isDerivedR2Key(`stores/${STORE}/products/a.png`)).toBe(false);
  });
  it('are never orphans, however old', () => {
    const r = classifyOrphans(
      [
        { key, size: 1, lastModified: new Date(NOW - 900 * DAY) },
        { key: 'stores/x/y.png', size: 1, lastModified: new Date(NOW - 900 * DAY) },
      ],
      new Set(),
      24 * 3600_000,
      NOW
    );
    expect(r.orphans).toEqual(['stores/x/y.png']);
  });
  it('expire after the retention window instead', () => {
    expect(DERIVED_R2_RETENTION_DAYS).toBe(400);
    expect(isExpiredDerivedKey(key, new Date(NOW - 401 * DAY), NOW)).toBe(true);
    expect(isExpiredDerivedKey(key, new Date(NOW - 399 * DAY), NOW)).toBe(false);
    expect(isExpiredDerivedKey(key, undefined, NOW)).toBe(false);
    expect(isExpiredDerivedKey('stores/x/y.png', new Date(NOW - 999 * DAY), NOW)).toBe(false);
  });
});
