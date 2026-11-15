import type { FiscalLine } from './fiscal-document.service';

/**
 * Per-line VAT for a sale document (payload v2). The order stores one VAT figure for the whole
 * order (goods + shipping + COD fee, after discounts), so the lines get their share of THAT figure:
 * proportional to each line's amount, the last non-zero line taking the rounding remainder. The
 * shares therefore always sum to the order's VAT exactly — the document total never moves.
 */
export function allocateLineVat(
  lines: Pick<FiscalLine, 'amount'>[],
  vat: number,
  vatRateBps: number | null
): Array<{ vatRateBps: number | null; vatAmount: number }> {
  const weight = lines.reduce((n, l) => n + Math.max(0, l.amount), 0);
  const out = lines.map(() => ({ vatRateBps, vatAmount: 0 }));
  if (vat <= 0 || weight <= 0) return out;
  let lastIdx = -1;
  lines.forEach((l, i) => {
    if (l.amount > 0) lastIdx = i;
  });
  let allocated = 0;
  lines.forEach((l, i) => {
    if (l.amount <= 0) return;
    const share = i === lastIdx ? vat - allocated : Math.round((vat * l.amount) / weight);
    out[i].vatAmount = share;
    allocated += share;
  });
  return out;
}
