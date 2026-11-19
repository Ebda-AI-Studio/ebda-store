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
  foldSearchLogTerm,
  isPersonalDataTerm,
  searchLogDay,
  searchLogTerm,
  SEARCH_LOG_RETENTION_DAYS,
} from '../../apps/api/src/services/search-log.service';

const DROPPED = [
  // email
  'ahmed@example.com',
  'Jane.Doe@Example.COM',
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
  // review round 1: every separator / Unicode form that slipped through
  '010–1234–5678', // en dash (iOS turns -- into one)
  '010—1234—5678', // em dash
  '010/1234/5678',
  '010_1234_5678',
  '010,1234,5678',
  '010 . 1234 . 5678',
  '٠١٠–١٢٣٤–٥٦٧٨', // Arabic-Indic with en dashes
  '٠١٠-١٢٣٤-٥٦٧٨', // Arabic-Indic with hyphens
  '010\u200f1234\u200f5678', // RLM marks, as WhatsApp / RTL contacts copy a number
  '\u200f01012345678\u200e', // RLM + LRM around it
  '01012\u200b345678', // zero-width space
  '010\u200d1234\u200c5678', // ZWJ + ZWNJ
  '０１０１２３４５６７８', // fullwidth digits
  '＋２０ １０１ ２３４ ５６７８', // fullwidth plus + digits
  'ahmed＠gmail.com', // fullwidth @
  'ahmed﹫gmail.com', // small commercial at
  'ORD TQX2P9 7A3FQ', // order number, spaces
  'ord_tqx2p9_7a3fq', // order number, underscores
  'ORD–TQX2P9–7A3FQ', // order number, en dashes
  'wa tqx2p9 7a3fq',
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
  'order 2024',
  'wa 7elw', // Franco: "and nice"
  'مقاس 42 43 44',
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

describe('accepted false positives (Ruling SEARCH-T5-3)', () => {
  // 8+ digits split by non-letters look like a phone: dropped from the log (the search itself
  // is unaffected). Pinned so a change to this trade-off is a visible decision.
  it.each(['size 38 40 42 44', '2024/2025', '5901234123457'])('drops %j', t =>
    expect(isPersonalDataTerm(t)).toBe(true)
  );
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

  it('folds fullwidth forms and invisible marks into the stored value (gate and value agree)', () => {
    expect(searchLogTerm('ＮＩＫＥ\u200f ａｉｒ')).toBe('nike air');
    expect(foldSearchLogTerm('كوت\u200cشي')).toBe('كوتشي');
  });

  it('checks the WHOLE folded term before the 100-char cut (a phone past char 100 is caught)', () => {
    const padded = `${'ف'.repeat(95)} 01012345678`;
    expect(searchLogTerm(padded)).toBeNull();
    const fullwidthTail = `${'a'.repeat(98)} ０１０１２３４５６７８`;
    expect(searchLogTerm(fullwidthTail)).toBeNull();
  });

  it('drops absurdly long input outright', () => {
    expect(searchLogTerm('ا'.repeat(1001))).toBeNull();
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

// Egypt DST (Law 2023): clocks go forward at 00:00 on the last Friday of April (to UTC+3) and
// back at 24:00 on the last Thursday of October (to UTC+2). 2026: Fri 24 April, Thu 29 October.
describe('searchLogDay across the Egypt DST switches', () => {
  it.each([
    // April: 23 Apr 23:59:59 local (UTC+2) is 21:59:59Z; the next second is 24 Apr 01:00 (UTC+3).
    ['2026-04-23T21:59:59Z', '2026-04-23'],
    ['2026-04-23T22:00:00Z', '2026-04-24'],
    ['2026-04-24T20:59:59Z', '2026-04-24'], // 23:59:59 at UTC+3
    ['2026-04-24T21:00:00Z', '2026-04-25'],
    // October: 29 Oct 23:59:59 local (UTC+3) is 20:59:59Z; then clocks fall back to 23:00 (UTC+2),
    // so 29 Oct has a 25th hour and still ends at 22:00Z.
    ['2026-10-29T20:59:59Z', '2026-10-29'],
    ['2026-10-29T21:00:00Z', '2026-10-29'], // the repeated 23:00, UTC+2
    ['2026-10-29T21:59:59Z', '2026-10-29'],
    ['2026-10-29T22:00:00Z', '2026-10-30'],
  ])('%s is Cairo day %s', (instant, day) => {
    expect(searchLogDay(new Date(instant))).toBe(day);
  });
});
