/**
 * Egyptian price parser for catalogue import. Deterministic: a tokeniser (digits, separators,
 * markers) followed by a small rule table. The model's own reading of a price is only ever a
 * cross-check; this function is authoritative (docs/plans/done/2026-10-21-search-p3-catalogue-import.md).
 * Money is integer piastres (minor units), never floats.
 */
import { toAsciiDigits } from '../instapay-receipt';

export type PriceKind = 'single' | 'range' | 'from' | 'per_unit' | 'discount' | 'none';
export type PriceCurrency = 'EGP' | 'OTHER' | 'UNKNOWN';

export interface ParsedPrice {
  minor: number | null;
  maxMinor: number | null;
  compareAtMinor: number | null;
  kind: PriceKind;
  currency: PriceCurrency;
  unit: string | null;
  ambiguous: boolean;
}

/** 0.50 EGP .. 10,000,000 EGP: outside this a number is a phone, a SKU or a misread. */
export const MIN_PRICE_MINOR = 50;
export const MAX_PRICE_MINOR = 1_000_000_000;

const NONE: ParsedPrice = {
  minor: null,
  maxMinor: null,
  compareAtMinor: null,
  kind: 'none',
  currency: 'UNKNOWN',
  unit: null,
  ambiguous: false,
};

const OTHER_CURRENCY =
  /\$|€|\b(usd|eur|gbp)\b|\u062F\u0648\u0644\u0627\u0631|\u062F\u064A\u0646\u0627\u0631|\u0631\u064A\u0627\u0644|\u062F\u0631\u0647\u0645|\u064A\u0648\u0631\u0648/i;
const EGP_CURRENCY =
  /\begp\b|(?<![a-z])l\.?\s?e(?![a-z])|e£|£\s?e|£|ج\s?\.\s?م|جنيه|جنية|جنيها|(?:^|[\d\s])ج(?:م)?(?=$|[\s./\d])/i;
const DISCOUNT = /قبل|بعد|\bwas\b|\bnow\b|\bbefore\b|\bafter\b/i;
const FROM = /يبدأ|يبدا|ابتداء|ابتدا|\bfrom\b|\bstarting\b|\bstarts?\b|^\s*من\s/i;
const RANGE_WORDS = /(?:\bto\b|إلى|الى|حتى)/i;
const PER_UNIT =
  /\/\s*(كيلو|كجم|كغ|kg|جرام|جم|لتر|ltr|l|قطعة|pcs?|حبة|دستة|dozen|متر|m)(?![a-z؀-ۿ])/i;

function numberTokens(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    let t = m[0];
    // "1,250" is thousands; "12,50" is a decimal comma.
    if (/,/.test(t)) t = /,\d{3}(?!\d)/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
    const n = Number(t);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function toMinor(n: number): number | null {
  const minor = Math.round(n * 100);
  return minor >= MIN_PRICE_MINOR && minor <= MAX_PRICE_MINOR ? minor : null;
}

export function parseEgpPrice(raw: string | null | undefined): ParsedPrice {
  if (!raw || !raw.trim()) return { ...NONE };
  const s = toAsciiDigits(raw)
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/[‎‏‪-‮]/g, '')
    .trim();
  const nums = numberTokens(s);
  if (nums.length === 0 || nums.every(n => n === 0)) return { ...NONE };

  const currency: PriceCurrency = OTHER_CURRENCY.test(s)
    ? 'OTHER'
    : EGP_CURRENCY.test(s)
      ? 'EGP'
      : 'UNKNOWN';
  const base = { ...NONE, currency };

  if (nums.length >= 2 && DISCOUNT.test(s)) {
    const hi = Math.max(nums[0], nums[1]);
    const lo = Math.min(nums[0], nums[1]);
    const ok = currency !== 'OTHER';
    return {
      ...base,
      kind: 'discount',
      minor: ok ? toMinor(lo) : null,
      compareAtMinor: ok ? toMinor(hi) : null,
    };
  }
  if (nums.length >= 2) {
    const sep = s.match(/\d\s*([-–—/])\s*\d/)?.[1];
    const isRange = RANGE_WORDS.test(s) || sep === '-' || sep === '–' || sep === '—';
    if (isRange) {
      const hi = toMinor(Math.max(nums[0], nums[1]));
      return { ...base, kind: 'range', minor: null, maxMinor: currency === 'OTHER' ? null : hi };
    }
    // Two numbers and no marker ("150/200"): ambiguous, no price.
    return { ...base, kind: 'single', minor: null, ambiguous: true };
  }

  const minor = currency === 'OTHER' ? null : toMinor(nums[0]);
  const unit = s.match(PER_UNIT)?.[1] ?? null;
  if (unit) return { ...base, kind: 'per_unit', minor, unit };
  if (FROM.test(s)) return { ...base, kind: 'from', minor };
  return { ...base, kind: 'single', minor };
}
