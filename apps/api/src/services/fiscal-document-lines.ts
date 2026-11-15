import type { FiscalLine } from './fiscal-document.service';

/**
 * Per-line VAT for a sale document (payload v2).
 *
 * The order stores ONE VAT figure (goods + shipping + COD fee + extra, after discounts). Every order discount
 * (coupon, promotion, loyalty) is taken off the GOODS subtotal — shipping, COD fee and extra are stored already
 * net of anything — so a line's taxable base is determinable from stored data:
 *   goods line  = its amount − its share of the order discount (shares proportional to line amount, remainder on
 *                 the last goods line);  fee line = its own amount.
 * The EXTRA charge is not in the order's VAT base (packages/shared/src/order-tax.ts), so an extra line carries 0.
 * Each other line's VAT is base × rate (tax-excluded) or base × rate / (1 + rate) (tax-included), rounded. When
 * those figures agree with the order's stored VAT to within 1 piaster per line, the last taxed line takes the
 * (tiny) difference. When they do not — an older order whose fees were outside its VAT (ruling MONEYB-2, no
 * stored taxable amount), or any drift — the order's VAT is split proportionally to the bases with the
 * largest-remainder rule instead: never negative, always summing to the order VAT, `fallback: true` so the
 * caller can log the order id.
 */
export function allocateLineVat(
  lines: Array<Pick<FiscalLine, 'amount' | 'kind'>>,
  discount: number,
  vat: number,
  vatRateBps: number | null,
  taxIncludedInPrice: boolean
): { shares: Array<{ vatRateBps: number | null; vatAmount: number }>; fallback: boolean } {
  const amounts = new Array<number>(lines.length).fill(0);
  const shares = lines.map(() => ({ vatRateBps, vatAmount: 0 }));
  if (vat <= 0) return { shares, fallback: false };

  const isGoods = (l: Pick<FiscalLine, 'kind'>) => l.kind === 'item' || l.kind === 'bundle';
  const goodsTotal = lines.reduce((n, l) => n + (isGoods(l) ? Math.max(0, l.amount) : 0), 0);
  const lastGoods = lines.reduce((acc, l, i) => (isGoods(l) && l.amount > 0 ? i : acc), -1);
  let given = 0;
  const base = lines.map((l, i) => {
    if (l.kind === 'extra') return 0; // outside the order's VAT base
    if (!isGoods(l) || l.amount <= 0 || goodsTotal <= 0) return Math.max(0, l.amount);
    const share =
      i === lastGoods
        ? Math.min(l.amount, Math.max(0, discount - given))
        : Math.min(l.amount, Math.round((discount * l.amount) / goodsTotal));
    given += share;
    return l.amount - share;
  });
  const taxed = base.map((b, i) => (b > 0 ? i : -1)).filter(i => i >= 0);

  let fallback = false;
  if (vatRateBps != null && taxed.length) {
    const own = base.map(b =>
      Math.round(
        taxIncludedInPrice ? (b * vatRateBps) / (10000 + vatRateBps) : (b * vatRateBps) / 10000
      )
    );
    const sum = own.reduce((n, v) => n + v, 0);
    const lastTaxed = taxed[taxed.length - 1];
    const adjusted = own[lastTaxed] + (vat - sum);
    if (Math.abs(vat - sum) <= lines.length && adjusted >= 0) {
      own[lastTaxed] = adjusted;
      own.forEach((v, i) => (amounts[i] = v));
    } else fallback = true;
  } else fallback = true;

  if (fallback) {
    // Largest-remainder split of the order VAT over the bases (all of it on the last line when nothing has a base).
    const weight = base.reduce((n, b) => n + b, 0);
    if (weight <= 0) {
      const target = lines.reduce((acc, l, i) => (l.kind === 'extra' ? acc : i), -1);
      amounts[target >= 0 ? target : lines.length - 1] = vat;
    } else {
      const floors = base.map(b => Math.floor((vat * b) / weight));
      let left = vat - floors.reduce((n, v) => n + v, 0);
      const order = base
        .map((b, i) => ({ i, rem: (vat * b) % weight }))
        .filter(x => base[x.i] > 0)
        .sort((a, b) => b.rem - a.rem || b.i - a.i);
      for (let k = 0; left > 0; k++, left--) floors[order[k % order.length].i] += 1;
      floors.forEach((v, i) => (amounts[i] = v));
    }
  }

  amounts.forEach((v, i) => (shares[i].vatAmount = v));
  // Invariant of an issued, immutable document: no negative line, lines sum to the order VAT.
  if (amounts.some(v => v < 0) || amounts.reduce((n, v) => n + v, 0) !== vat)
    throw new Error('line VAT allocation broke its invariant');
  return { shares, fallback };
}
