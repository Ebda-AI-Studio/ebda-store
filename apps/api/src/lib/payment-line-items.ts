import { groupOrderLinesForDisplay, type OrderLineBase } from '@force/shared';
import type { PaymentItem } from '../services/payment-providers/types';

export interface PaymentLineItemSource extends OrderLineBase {
  productName: string;
  sku?: string | null;
}

/**
 * Builds the `PaymentItem[]` a payment provider's own hosted page displays
 * to the customer.
 *
 * Final-review I3: every OTHER customer-facing surface (cart, checkout,
 * success, orders list, order detail, returns, invoice, both order emails)
 * already collapses a bundle's component `OrderItem` rows into one row via
 * `groupOrderLinesForDisplay`. The three payment-provider call sites
 * (`payment.routes.ts` /create, `order.routes.ts` payment-link,
 * `payment.factory.ts` retry) were mapping `order.items` directly, so a
 * customer paying for "Ramadan Box · 12.000" saw "Dates 3.724 / Honey 4.966
 * / Nuts ×2 @ 1.655" on the gateway's OWN branded page, with no bundle name
 * — the one screen where per-component allocated prices are most damaging
 * to trust.
 *
 * The totals MUST still reconcile exactly to what the provider charges:
 * Σ(unitPrice × quantity) here is unchanged by this collapse, because
 * `groupOrderLinesForDisplay`'s bundle `total` is exactly the sum of that
 * group's component line totals (the allocation invariant proved in
 * `bundle-pricing.ts`), and every collapsed row uses quantity 1 with
 * `unitPrice` set to that total.
 */
export function buildPaymentLineItems(items: readonly PaymentLineItemSource[]): PaymentItem[] {
  return groupOrderLinesForDisplay(items).map(line => {
    if (line.kind === 'bundle') {
      return {
        name: line.name,
        // Always 1 — a bundleGroupId is exactly one box; N boxes produce N
        // separate groups/rows, never one row at quantity N.
        quantity: line.quantity,
        unitPrice: line.total,
      };
    }
    return {
      name: line.item.productName,
      quantity: line.item.quantity,
      unitPrice: line.item.price,
      sku: line.item.sku || undefined,
    };
  });
}
