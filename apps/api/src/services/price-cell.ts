import { tryToMinor } from '@ebda/shared';

/**
 * One parser for every price cell a merchant can upload (platform CSV, XLSX,
 * Shopify CSV). Cells are EGP as merchants type them — `250`, `250.5`,
 * `1,250.50`, `٢٥٠٫٥٠` — and are converted to integer piastres with the shared
 * `tryToMinor`; there is no second conversion anywhere in the import pipeline.
 *
 * Three-decimal values are rejected outright: `12.500` is a Kuwaiti-dinar
 * habit, and in Egypt a cell like that may be a thousands separator
 * ("twelve thousand five hundred"). Guessing either way silently misprices a
 * live product, so the row fails and the merchant retypes it.
 */

export type PriceErrorCode =
  | 'PRICE_REQUIRED'
  | 'PRICE_INVALID'
  | 'PRICE_NEGATIVE'
  | 'PRICE_AMBIGUOUS_DECIMALS'
  | 'PRICE_TOO_MANY_DECIMALS';

export type PriceCellResult =
  | { ok: true; minor: number | null }
  | { ok: false; code: PriceErrorCode; message: string };

/** Product.price / ProductVariant.price are Postgres INT. */
const MAX_MINOR = 2_147_483_647;

const RTL_MARKS = /[‎‏‪-‮⁦-⁩﻿]/g;

function toAscii(input: string): string {
  return input
    .replace(RTL_MARKS, '')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.') // Arabic decimal separator ٫
    .replace(/[٬،]/g, ',') // Arabic thousands separator ٬ and Arabic comma ،
    .replace(/−/g, '-') // unicode minus
    .trim();
}

/** Leading code of an error string produced by this module, or null. */
export function priceErrorCode(error: string): PriceErrorCode | null {
  const m = /^(PRICE_[A-Z_]+):/.exec(error);
  return m ? (m[1] as PriceErrorCode) : null;
}

/** Column label of an error string produced by this module (`CODE: <label> "value" ...`). */
export function priceErrorColumn(error: string): string | null {
  const m = /^PRICE_[A-Z_]+: (.+?) "/.exec(error);
  return m ? m[1] : null;
}

export function parsePriceCell(
  raw: string | null | undefined,
  opts: { required?: boolean; label?: string } = {}
): PriceCellResult {
  const label = opts.label ?? 'price';
  const text = toAscii(raw ?? '');
  const fail = (code: PriceErrorCode, reason: string): PriceCellResult => ({
    ok: false,
    code,
    message: `${code}: ${label} "${(raw ?? '').trim()}" ${reason}`,
  });

  if (text === '') {
    return opts.required
      ? fail('PRICE_REQUIRED', 'is required (price in EGP, e.g. 250 or 250.50)')
      : { ok: true, minor: null };
  }

  let body = text;
  let negative = false;
  if (body.startsWith('-')) {
    negative = true;
    body = body.slice(1);
  }
  // Well-formed thousands grouping only ("1,250.50"); "12,5" / "1,2345" are
  // never guessed at.
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(body)) body = body.replace(/,/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(body)) {
    return fail('PRICE_INVALID', 'is not a valid EGP amount (digits only, e.g. 250 or 250.50)');
  }
  if (negative) {
    return Number(body) === 0
      ? { ok: true, minor: 0 }
      : fail('PRICE_NEGATIVE', 'must not be negative');
  }

  const frac = body.split('.')[1] ?? '';
  if (frac.length === 3) {
    return fail(
      'PRICE_AMBIGUOUS_DECIMALS',
      'has 3 decimals and is ambiguous (12.500 may mean 12.5 or 12,500). Use at most 2 decimals, e.g. 250 or 250.50'
    );
  }
  if (frac.replace(/0+$/, '').length > 2) {
    return fail('PRICE_TOO_MANY_DECIMALS', 'has more than 2 decimals; use e.g. 250 or 250.50');
  }

  const minor = tryToMinor(body, 'EGP');
  if (minor === null || minor > MAX_MINOR) {
    return fail('PRICE_INVALID', 'is not a valid EGP amount (digits only, e.g. 250 or 250.50)');
  }
  return { ok: true, minor };
}
