/**
 * VAT on an order is levied AFTER discount (owner decision, #193): the taxable
 * base is `subtotal − discount`, never negative, where `discount` is the
 * order's persisted discount (winning coupon-or-promotion plus loyalty).
 *
 * Both order-creation paths call this, and it is the ONE place the base is
 * decided, because everything downstream reads the persisted `order.tax`
 * rather than recomputing it — the charge, the receipt/invoice, the
 * confirmation email, the GL posting (2100 Tax Payable) and the tax report,
 * whose `taxableBase = subtotal − discount` was already written against this
 * base. Before this, checkout levied tax on the pre-discount subtotal, so for
 * any discounted order the report's derived rate was inflated and split a
 * single-rate store into spurious rate buckets.
 *
 * `rate` is a fraction (5% → 0.05). A store with no active tax rate passes 0
 * and gets 0 — identical to before for every store with tax off.
 */
export function computeOrderTax(subtotal: number, discount: number, rate: number): number {
  return Math.round(Math.max(0, subtotal - discount) * rate);
}
