/**
 * Cumulative allocation of an order's money across a partial return's lines.
 *
 * This is shared on purpose. Two places need the same answer:
 *
 *  - `partial-return-posting.ts` books DR Sales Returns / DR Tax / CR Cash for
 *    the returned lines, and
 *  - `ReturnService.complete` decides how much to actually refund at the
 *    payment provider.
 *
 * If those two disagree, the GL says one number and the customer's card shows
 * another, and nothing surfaces the drift because the trial balance still
 * balances. Computing them from one function makes the money movement equal
 * the journal entry by construction rather than by review.
 *
 * Allocation is a cumulative floor by gross-returned-so-far, not a per-return
 * percentage: `entitled(total_returned) − entitled(previously_returned)`. That
 * is what keeps a sequence of partial returns summing to exactly the order's
 * discount and tax instead of drifting a fil per return, and it is why prior
 * returns have to be passed in rather than inferred.
 *
 * Everything is integer fils. `amount * gross` stays far below
 * Number.MAX_SAFE_INTEGER for any real order.
 */

/** The subset of an order line this allocation needs. */
export interface AllocationLine {
  id: string;
  quantity: number;
  /** Unit price in fils. */
  price: number;
}

export interface AllocationResult<L extends AllocationLine> {
  /** Gross value of the lines returned by PRIOR completed returns. */
  prevGross: number;
  /** Gross value of the lines returned by THIS return, clamped to remainder. */
  curGross: number;
  /** This return's share of the order-level discount. */
  discountThis: number;
  /** This return's share of the order-level tax. */
  taxThis: number;
  /** DR Sales Returns — gross less the discount share. */
  revenueDebit: number;
  /**
   * CR Cash — what the customer is actually owed back for these lines, and
   * therefore the amount to refund at the provider.
   */
  cashCredit: number;
  /** The lines actually being returned, after clamping. Empty = nothing to do. */
  returnedLines: Array<{ line: L; qty: number }>;
}

export function allocatePartialReturn<L extends AllocationLine>(input: {
  /** Order subtotal in fils — the basis the discount and tax are allocated over. */
  subtotal: number;
  /** Order-level discount in fils. */
  discount: number;
  /** Order-level tax in fils. */
  tax: number;
  /** Every line on the order. */
  lines: L[];
  /** Quantity per orderItemId already returned by PRIOR completed returns. */
  prevQty: Map<string, number>;
  /** The lines this return is claiming. */
  requested: Array<{ orderItemId: string; quantity: number }>;
}): AllocationResult<L> {
  const { subtotal, discount, tax, lines, prevQty, requested } = input;

  // `claimed` runs cumulatively so duplicate orderItemIds in one payload
  // cannot double-count against the same line's remainder.
  let prevGross = 0;
  const claimed = new Map<string, number>();
  for (const line of lines) {
    const prev = Math.min(prevQty.get(line.id) ?? 0, line.quantity);
    prevGross += line.price * prev;
    claimed.set(line.id, prev);
  }

  let curGross = 0;
  const returnedLines: Array<{ line: L; qty: number }> = [];
  for (const req of requested) {
    const line = lines.find(i => i.id === req.orderItemId);
    if (!line) continue; // foreign/unknown line — never adjust for it
    const already = claimed.get(line.id) ?? 0;
    const qty = Math.min(Math.max(0, Math.floor(req.quantity)), line.quantity - already);
    if (qty === 0) continue;
    claimed.set(line.id, already + qty);
    curGross += line.price * qty;
    returnedLines.push({ line, qty });
  }

  const entitled = (amount: number, gross: number): number => {
    if (amount <= 0 || subtotal <= 0) return 0;
    const g = Math.min(gross, subtotal);
    return Math.min(amount, Math.floor((amount * g) / subtotal));
  };

  const cumGross = prevGross + curGross;
  const discountThis = Math.min(
    entitled(discount, cumGross) - entitled(discount, prevGross),
    curGross
  );
  const taxThis = entitled(tax, cumGross) - entitled(tax, prevGross);
  const revenueDebit = curGross - discountThis;
  const cashCredit = revenueDebit + taxThis;

  return { prevGross, curGross, discountThis, taxThis, revenueDebit, cashCredit, returnedLines };
}
