/**
 * The variant-aware stock helper every reader must go through.
 *
 * Regression context: `products.inventory` is not stock for a product that
 * has variants, but six call sites read it as if it were. Checkout also
 * decremented it on every variant sale, so it had drifted to -16 on live
 * products whose variants held four-figure stock.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  effectiveInventory,
  isOrderable,
  EFFECTIVE_STOCK_SELECT,
} from '@api/lib/effective-inventory';

describe('effectiveInventory', () => {
  it('returns the product column when the product has no variants', () => {
    expect(effectiveInventory({ inventory: 7, variants: [] })).toBe(7);
    expect(effectiveInventory({ inventory: 7 })).toBe(7);
    expect(effectiveInventory({ inventory: 7, variants: null })).toBe(7);
  });

  it('sums the variants and ignores the parent column when variants exist', () => {
    expect(
      effectiveInventory({ inventory: -16, variants: [{ inventory: 1000 }, { inventory: 173 }] })
    ).toBe(1173);
  });

  it('never lets a corrupted negative parent leak through a variant product', () => {
    // The exact production shape: parent drifted negative, variants hold real stock.
    expect(effectiveInventory({ inventory: -16, variants: [{ inventory: 1173 }] })).toBe(1173);
  });

  it('returns 0, not the parent, for a variant product whose variants are empty', () => {
    expect(effectiveInventory({ inventory: -4, variants: [{ inventory: 0 }] })).toBe(0);
  });
});

describe('isOrderable', () => {
  const enabled = true;

  it('is always orderable when the product does not track inventory', () => {
    expect(isOrderable({ inventory: -16, trackInventory: false }, 5, enabled)).toBe(true);
  });

  it('uses variant stock for a variant product', () => {
    const p = { inventory: -16, trackInventory: true, variants: [{ inventory: 1173 }] };
    expect(isOrderable(p, 3, enabled)).toBe(true);
  });

  it('rejects when the requested qty exceeds variant stock and no backorder is allowed', () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: false,
      variants: [{ inventory: 2 }],
    };
    expect(isOrderable(p, 3, enabled)).toBe(false);
  });

  it('allows a backorder only when the feature flag AND the product flag are set', () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: true,
      variants: [{ inventory: 0 }],
    };
    expect(isOrderable(p, 3, true)).toBe(true);
    expect(isOrderable(p, 3, false)).toBe(false);
  });

  it('allows a backorder when any variant permits it, matching enrichStockFlags', () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: false,
      variants: [{ inventory: 0, allowBackorder: true }],
    };
    expect(isOrderable(p, 3, true)).toBe(true);
  });
});

// #1103 — owner decision 2026-09-25: a disabled variant (isActive=false) is
// not stock anywhere. Before, these helpers summed every variant while the
// admin list and the WhatsApp bridge summed only active ones, so one product
// showed two different stock figures and could read "in stock" on units no
// checkout would sell.
describe('disabled variants are not stock (#1103)', () => {
  it('a disabled variant contributes nothing to effective stock', () => {
    expect(
      effectiveInventory({
        inventory: 0,
        variants: [
          { inventory: 3, isActive: true },
          { inventory: 50, isActive: false },
        ],
      })
    ).toBe(3);
  });

  it('a product whose every variant is disabled has 0, not its parent column', () => {
    expect(
      effectiveInventory({ inventory: 7, variants: [{ inventory: 50, isActive: false }] })
    ).toBe(0);
  });

  it('an omitted isActive counts as active (callers that pre-filter to active rows)', () => {
    expect(effectiveInventory({ inventory: 0, variants: [{ inventory: 4 }] })).toBe(4);
  });

  it('stock held only by a disabled variant is not orderable', () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: false,
      variants: [{ inventory: 50, isActive: false }],
    };
    expect(isOrderable(p, 1, false)).toBe(false);
  });

  it("a disabled variant's allowBackorder does not open a backorder on the product", () => {
    const p = {
      inventory: 0,
      trackInventory: true,
      allowBackorder: false,
      variants: [
        { inventory: 0, allowBackorder: false, isActive: true },
        { inventory: 0, allowBackorder: true, isActive: false },
      ],
    };
    expect(isOrderable(p, 1, true)).toBe(false);
  });

  it('EFFECTIVE_STOCK_SELECT selects isActive, so no consumer can silently omit it', () => {
    expect(EFFECTIVE_STOCK_SELECT.variants.select.isActive).toBe(true);
  });
});

describe('no API query re-derives variant stock blind to isActive (#1103)', () => {
  const API_SRC = path.resolve(__dirname, '../../apps/api/src');
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : files(abs);
      return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [abs] : [];
    });
  }

  it('every stock-only variant select also selects isActive, and every "has stock" relation filter requires it', () => {
    // The shapes each consumer used to hand-roll: a variants select of
    // inventory alone (summed later without knowing which rows are disabled),
    // and a `some: { inventory > 0 }` filter that a disabled variant satisfies.
    const blind = [
      /variants:\s*{\s*select:\s*{\s*inventory:\s*true\s*}\s*}/,
      /variants:\s*{\s*some:\s*{\s*inventory:/,
    ];
    const offenders = files(API_SRC).flatMap(f => {
      const src = fs.readFileSync(f, 'utf8');
      return blind.filter(re => re.test(src)).map(re => `${path.relative(API_SRC, f)}  ${re}`);
    });
    expect(offenders).toEqual([]);
  });

  // Issue 2077: the regexes above only matched a select of `inventory` ALONE.
  // `variants: { where: { isActive: true }, select: { inventory, allowBackorder } }`
  // slipped past them — and it is the worse shape: an all-disabled product
  // filters to ZERO rows, so `effectiveInventory` reads "no variants" and
  // falls back to the parent column. Every variants select that reads
  // `inventory` must select `isActive` too. (The PDP picker, once the one
  // display-only exception, now selects `isActive` too — issue 2147 — so the
  // allowlist is empty; add a file here only with a written reason.)
  const DISPLAY_ONLY: Record<string, number> = {};

  function variantBlocks(src: string): Array<{ line: number; text: string }> {
    const out: Array<{ line: number; text: string }> = [];
    const re = /variants:\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < src.length && depth) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      out.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, i) });
    }
    return out;
  }

  function isActiveBlind(block: string): boolean {
    const sel = block.match(/select:\s*\{([\s\S]*)\}/);
    if (!sel) return false;
    return /\binventory:\s*true/.test(sel[1]) && !/\bisActive:\s*true/.test(sel[1]);
  }

  it('the brace-aware check catches the where-filtered shape (positive control)', () => {
    const bad =
      'variants: { where: { isActive: true }, select: { inventory: true, allowBackorder: true } },';
    const good = 'variants: { select: { inventory: true, allowBackorder: true, isActive: true } },';
    expect(variantBlocks(bad).some(b => isActiveBlind(b.text))).toBe(true);
    expect(variantBlocks(good).some(b => isActiveBlind(b.text))).toBe(false);
  });

  it('every variants select that reads inventory also selects isActive (issue 2077)', () => {
    const offenders: string[] = [];
    for (const f of files(API_SRC)) {
      const rel = path.relative(API_SRC, f);
      const blind = variantBlocks(fs.readFileSync(f, 'utf8')).filter(b => isActiveBlind(b.text));
      const allowed = DISPLAY_ONLY[rel] ?? 0;
      if (blind.length > allowed) offenders.push(...blind.map(b => `${rel}:${b.line}`));
    }
    expect(offenders).toEqual([]);
  });

  // Issue 2147: a select that PRE-FILTERS the relation to active rows (with any
  // select after it) hands a product whose variants are all disabled to the
  // helper as variant-less, and the helper then falls back to the parent
  // column. In any file that computes stock, variants must be selected
  // unfiltered, with `isActive`, and disabled rows dropped for display after.
  // Mutation proof: restore `where: { isActive: true }` on the PDP select → this goes red.
  it('no stock-computing file pre-filters its variants relation to isActive', () => {
    const preFiltered =
      /variants:\s*{\s*(?:orderBy:\s*{[^}]*},\s*)?where:\s*{\s*isActive:\s*true\s*}/;
    const computesStock = /effectiveInventory\(|isOrderable\(|enrichStockFlags\(/;
    const offenders = files(API_SRC).filter(f => {
      const src = fs.readFileSync(f, 'utf8');
      return computesStock.test(src) && preFiltered.test(src);
    });
    expect(offenders.map(f => path.relative(API_SRC, f))).toEqual([]);
  });
});
