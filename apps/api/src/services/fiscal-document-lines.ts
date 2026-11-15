import type { FiscalLine } from './fiscal-document.service';

/**
 * Per-line VAT for a sale document (payload v2).
 *
 * The order stores ONE VAT figure (goods + shipping + COD fee + extra, after discounts). Every order discount
 * (coupon, promotion, loyalty) is taken off the GOODS subtotal — shipping, COD fee and extra are stored already
 * net of anything — so a line's taxable base is determinable from stored data:
 *   goods line  = its amount − its share of the order discount (shares proportional to line amount, remainder on
 *                 the last goods line);  fee line = its own amount.
 * Each line's VAT is base × rate (tax-excluded) or base × rate / (1 + rate) (tax-included), rounded; the last
 * non-zero line then takes the difference to the order's VAT, so the lines always sum to it exactly.
 */
export function allocateLineVat(
  lines: Array<Pick<FiscalLine, 'amount' | 'kind'>>,
  discount: number,
  vat: number,
  vatRateBps: number | null,
  taxIncludedInPrice: boolean
): Array<{ vatRateBps: number | null; vatAmount: number }> {
  const out = lines.map(() => ({ vatRateBps, vatAmount: 0 }));
  if (vat <= 0) return out;

  const isGoods = (l: Pick<FiscalLine, 'kind'>) => l.kind === 'item' || l.kind === 'bundle';
  const goodsTotal = lines.reduce((n, l) => n + (isGoods(l) ? Math.max(0, l.amount) : 0), 0);
  const lastGoods = lines.reduce((acc, l, i) => (isGoods(l) && l.amount > 0 ? i : acc), -1);
  let given = 0;
  const base = lines.map((l, i) => {
    if (!isGoods(l) || l.amount <= 0 || goodsTotal <= 0) return Math.max(0, l.amount);
    const share =
      i === lastGoods
        ? Math.min(l.amount, discount - given)
        : Math.min(l.amount, Math.round((discount * l.amount) / goodsTotal));
    given += share;
    return l.amount - share;
  });

  const weight = base.reduce((n, b) => n + b, 0);
  if (weight <= 0) return out;
  const own = base.map(b =>
    vatRateBps != null
      ? Math.round(
          taxIncludedInPrice ? (b * vatRateBps) / (10000 + vatRateBps) : (b * vatRateBps) / 10000
        )
      : Math.round((vat * b) / weight)
  );
  let last = -1;
  base.forEach((b, i) => {
    if (b > 0) last = i;
  });
  let allocated = 0;
  base.forEach((b, i) => {
    if (b <= 0) return;
    out[i].vatAmount = i === last ? vat - allocated : own[i];
    allocated += out[i].vatAmount;
  });
  return out;
}
