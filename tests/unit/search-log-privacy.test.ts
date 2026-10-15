/**
 * Search program P0, Task 5 (Review Focus 3): a shopper who pastes a phone, an email, an
 * order number or an id into the storefront search box must never have it stored in
 * `search_query_daily`. `isPersonalDataTerm` is the gate; it normalises first (Arabic-Indic
 * and Persian digits fold to ASCII, Latin folds to lower case), so the raw and the
 * normalised term get the same answer (E3).
 */
import { describe, it, expect } from 'vitest';
import { normalizeArabicSearch } from '@ebda/shared';
import {
  isPersonalDataTerm,
  searchLogTerm,
  SEARCH_LOG_RETENTION_DAYS,
} from '../../apps/api/src/services/search-log.service';

const DROPPED = [
  // email
  'ahmed@example.com',
  'Ahmed.Hassan@Gmail.COM',
  'ahmed@gmail', // half-typed: any @ is dropped
  // phone, every way an Egyptian shopper writes one
  '01012345678',
  '+20 101 234 5678',
  '٠١٠١٢٣٤٥٦٧٨', // Arabic-Indic digits
  '۰۱۰۱۲۳۴۵۶۷۸', // Persian digits
  '0020 1012345678',
  '010-1234-5678',
  '(010) 1234 5678',
  'ahmed 01012345678', // a phone inside a longer term
  'رقمي ٠١٠١٢٣٤٥٦٧٨',
  // 14-digit national id
  '29801011234567',
  // order numbers (current and legacy shapes, both prefixes)
  'ORD-TQX2P9-7A3FQ',
  'ord-tqx2p9-7a3fq',
  'WA-TQX2P9-7A3FQ',
  'ORD-1760500000000-a1b2c3d4',
  // ids / tokens
  '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  'ckv9x8y7z6w5v4u3t2s1r0q9p',
  'a1b2c3d4e5f6a7b8c9d0e1f2',
  // links (can carry tokens)
  'https://ebda.app/track?t=abc',
  'www.example.com/order',
];

const KEPT = [
  'جزمه 42',
  'iphone 15 pro',
  'مقاس 44',
  'sku-1234',
  'كوتشي',
  'galaxy s24 ultra 256gb',
  'tv 55 inch 4k',
  'رقم 7',
  'order',
  'تيشرت اسود xl',
  'nike air max 270',
  '2024',
];

describe('isPersonalDataTerm', () => {
  it.each(DROPPED)('drops %j', t => expect(isPersonalDataTerm(t)).toBe(true));
  it.each(KEPT)('keeps %j', t => expect(isPersonalDataTerm(t)).toBe(false));

  it('gives the raw and the normalised term the same answer', () => {
    for (const t of [...DROPPED, ...KEPT]) {
      expect(isPersonalDataTerm(normalizeArabicSearch(t))).toBe(isPersonalDataTerm(t));
    }
  });
});

describe('searchLogTerm', () => {
  it('normalises, so spelling variants share one row', () => {
    expect(searchLogTerm('أحذية')).toBe('احذيه');
    expect(searchLogTerm('  احذيه ')).toBe('احذيه');
    expect(searchLogTerm('IPhone   15')).toBe('iphone 15');
  });

  it('returns null for a term that must not be stored', () => {
    expect(searchLogTerm('٠١٠١٢٣٤٥٦٧٨')).toBeNull();
    expect(searchLogTerm('ahmed@example.com')).toBeNull();
    expect(searchLogTerm('a')).toBeNull(); // under the 2-char floor
    expect(searchLogTerm('   ')).toBeNull();
  });

  it('caps at 100 code points without splitting a surrogate pair', () => {
    const long = '😀'.repeat(150);
    const out = searchLogTerm(long)!;
    expect([...out]).toHaveLength(100);
    expect(out).toBe('😀'.repeat(100));
  });

  it('keeps 90 days', () => {
    expect(SEARCH_LOG_RETENTION_DAYS).toBe(90);
  });
});
