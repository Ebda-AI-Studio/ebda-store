// VERBATIM COPY of apps/api/src/services/accounting/posting/partial-return-allocation.ts (see return-adjustment.ts for why a copy).
// tests/unit/do-return-math-parity.test.ts keeps it equal to the original (fuzzed). Ruling CF-RETURNS-1.
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
 * discount and tax instead of drifting a piastre per return, and it is why prior
 * returns have to be passed in rather than inferred.
 *
 * Everything is integer piastres. `amount * gross` stays far below
 * Number.MAX_SAFE_INTEGER for any real order.
 */

/** The subset of an order line this allocation needs. */
export interface AllocationLine {
  id: string;
  quantity: number;
  /** Unit price in piastres. */
  price: number;
  /**
   * `OrderItem.priceSource`. A line priced by a tier or a group price ('tier' / 'group') never received the order's
   * coupon / promotion / loyalty discount (Ruling B2B-5, M3), so it carries no share of it back (final review P2-2).
   * null / 'base' = discount-eligible (every line sold before B2B). Required, so no caller can silently omit it and
   * disagree with the others.
   */
  priceSource: string | null;
}

/** Ruling B2B-5: only base-priced lines were in the discount basis. */
const discountEligible = (l: AllocationLine): boolean =>
  l.priceSource == null || l.priceSource === 'base';

export interface AllocationResult<L extends AllocationLine> {
  /** Gross value of the lines returned by PRIOR completed returns. */
  prevGross: number;
  /** Gross value of the lines returned by THIS return, clamped to remainder. */
  curGross: number;
  /** This return's share of the order-level discount. */
  discountThis: number;
  /** This return's share of the order-level tax. */
  taxThis: number;
  /**
   * DR Sales Returns — the revenue actually being taken back, which is net of
   * both the discount share and (for a tax-inclusive order) the tax share,
   * mirroring what the sale credited to revenue.
   */
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
  /** Order subtotal in piastres — the basis the discount and tax are allocated over. */
  subtotal: number;
  /** Order-level discount in piastres. */
  discount: number;
  /** Order-level tax in piastres. */
  tax: number;
  /**
   * `Order.taxIncludedInPrice` — was `tax` already inside the line prices when
   * the order was charged (ruling M3-7)? Default `false` (exclusive: the
   * customer paid the line price PLUS its tax share). Pass the order's own
   * persisted flag, never the store's current switch: it can be flipped
   * between the sale and the return.
   */
  taxIncludedInPrice?: boolean;
  /** Every line on the order. */
  lines: L[];
  /** Quantity per orderItemId already returned by PRIOR completed returns. */
  prevQty: Map<string, number>;
  /** The lines this return is claiming. */
  requested: Array<{ orderItemId: string; quantity: number }>;
  /**
   * B2B tier-aware returns (Task 8b): signed piastres by which EARLIER returns' credited value was reduced (kept units
   * repriced below their tier), and by which THIS return's is. Subtracted from the gross each side contributes, so the
   * discount and tax shares, the revenue debit and the cash credit all follow the adjusted value and the GL and the
   * provider refund stay one number. Both default to 0: every caller that passes neither is unchanged.
   */
  prevAdjustment?: number;
  thisAdjustment?: number;
}): AllocationResult<L> {
  const {
    subtotal,
    discount,
    tax,
    taxIncludedInPrice = false,
    lines,
    prevQty,
    requested,
    prevAdjustment = 0,
    thisAdjustment = 0,
  } = input;

  // `claimed` runs cumulatively so duplicate orderItemIds in one payload
  // cannot double-count against the same line's remainder.
  let prevGross = 0;
  // The discount is allocated over the discount-ELIGIBLE gross only (P2-2): its basis is the subtotal less the lines that
  // never got it. For an order with no tier / group line both equal the old whole-subtotal figures.
  let prevEligible = 0;
  let ineligibleSubtotal = 0;
  const claimed = new Map<string, number>();
  for (const line of lines) {
    const prev = Math.min(prevQty.get(line.id) ?? 0, line.quantity);
    prevGross += line.price * prev;
    if (discountEligible(line)) prevEligible += line.price * prev;
    else ineligibleSubtotal += line.price * line.quantity;
    claimed.set(line.id, prev);
  }

  let curGross = 0;
  let curEligible = 0;
  const returnedLines: Array<{ line: L; qty: number }> = [];
  for (const req of requested) {
    const line = lines.find(i => i.id === req.orderItemId);
    if (!line) continue; // foreign/unknown line — never adjust for it
    const already = claimed.get(line.id) ?? 0;
    const qty = Math.min(Math.max(0, Math.floor(req.quantity)), line.quantity - already);
    if (qty === 0) continue;
    claimed.set(line.id, already + qty);
    curGross += line.price * qty;
    if (discountEligible(line)) curEligible += line.price * qty;
    returnedLines.push({ line, qty });
  }

  const entitledOver = (amount: number, gross: number, basis: number): number => {
    if (amount <= 0 || basis <= 0) return 0;
    const g = Math.min(gross, basis);
    return Math.min(amount, Math.floor((amount * g) / basis));
  };
  const entitled = (amount: number, gross: number): number => entitledOver(amount, gross, subtotal);
  const discountBasis = subtotal - ineligibleSubtotal;

  // Credited value after the tier adjustment. `prevGross` / `curGross` in the RESULT stay the raw gross.
  const prevCredited = Math.max(0, prevGross - prevAdjustment);
  const curCredited = Math.max(0, curGross - thisAdjustment);
  const cumGross = prevCredited + curCredited;
  // Discount: by the ELIGIBLE gross returned, over the eligible basis. The tier adjustment does not shrink it: it charges
  // for KEPT units being repriced, which says nothing about how much discount the RETURNED units received (when the
  // adjustment lands on a base-priced item of the same product, Ruling B2B-17, that item's coupon share still comes back
  // in full). With no tier / group line and no adjustment this is exactly the old whole-subtotal figure.
  const discountThis = Math.min(
    entitledOver(discount, prevEligible + curEligible, discountBasis) -
      entitledOver(discount, prevEligible, discountBasis),
    curCredited
  );
  // The line value the customer is being credited for, less their discount
  // share. Which SIDE of it the tax sits on is the only thing the two tax
  // conventions disagree about, and both keep the adjustment balanced
  // (revenueDebit + taxThis === cashCredit):
  //   exclusive — the line price carried no tax, so the customer is owed that
  //     price PLUS its tax share, and the whole price was revenue.
  //   inclusive — the tax was already inside the line price, so the customer
  //     is owed that price and NO MORE (adding taxThis on top refunds the VAT
  //     a second time), and the revenue the sale booked was the price LESS
  //     its tax share.
  const netOfDiscount = curCredited - discountThis;
  // An inclusive share comes OUT of the line value, so it cannot exceed it —
  // clamped so a rounding edge can never produce a negative revenue debit
  // (which partial-return-posting would drop, unbalancing the entry).
  const taxThis = taxIncludedInPrice
    ? Math.min(entitled(tax, cumGross) - entitled(tax, prevCredited), netOfDiscount)
    : entitled(tax, cumGross) - entitled(tax, prevCredited);
  const revenueDebit = taxIncludedInPrice ? netOfDiscount - taxThis : netOfDiscount;
  const cashCredit = revenueDebit + taxThis;

  return { prevGross, curGross, discountThis, taxThis, revenueDebit, cashCredit, returnedLines };
}

/**
 * Split one partial refund between the customer wallet and the card, in the
 * proportions the order was originally paid (owner decision 2026-10-01, #1956):
 * the order total `total` was paid `walletAmount` from the wallet and the rest
 * at the gateway.
 *
 * Cumulative, like the discount/tax allocation above: the wallet is entitled
 * to `floor(cash × walletAmount / total)` of everything refunded so far, and
 * this refund takes the difference between that entitlement after and before
 * it. Every rounding remainder therefore lands on the CARD (the floor is taken
 * on the wallet side), deterministically, and the card's cumulative share can
 * never exceed what the card paid: it is at most
 * `ceil(cash × (total − walletAmount) / total)`, which is ≤ the integer
 * `total − walletAmount` whenever `cash ≤ total`. A per-refund floor would
 * instead hand the card up to one extra piastre per refund and could push the
 * last piece over the payment's refundable balance.
 *
 * `prevCash` is the cash value of every earlier item-level reversal of the
 * order (the same allocation, over the prior quantities) — see
 * ReturnService.allocateThisReturn. All integer piastres.
 */
export function splitByPaymentMix(input: {
  /** What this refund is worth (the allocation's `cashCredit`). */
  cashCredit: number;
  /** Cash value of the order's earlier item-level reversals. */
  prevCash: number;
  /** Order total, piastres — what wallet + card paid together. */
  total: number;
  /** Part of `total` paid from the customer wallet at checkout. */
  walletAmount: number;
}): { walletShare: number; gatewayShare: number } {
  const { cashCredit, prevCash, total, walletAmount } = input;
  if (cashCredit <= 0) return { walletShare: 0, gatewayShare: 0 };
  if (walletAmount <= 0 || total <= 0) return { walletShare: 0, gatewayShare: cashCredit };
  const w = Math.min(walletAmount, total);
  const walletEntitled = (cash: number): number =>
    Math.floor((Math.min(Math.max(cash, 0), total) * w) / total);
  const walletShare = Math.min(
    cashCredit,
    walletEntitled(prevCash + cashCredit) - walletEntitled(prevCash)
  );
  return { walletShare, gatewayShare: cashCredit - walletShare };
}
