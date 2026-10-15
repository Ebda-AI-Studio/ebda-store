/**
 * Groups order/return lines for CUSTOMER-FACING display.
 *
 * The API expands a bundle purchase into ordinary component `OrderItem`
 * rows at checkout, each tagged with a shared `bundleGroupId` — one id per
 * BOX, never per bundle-in-cart, so a single box is independently
 * returnable even when the order contains two of the same bundle.
 * Customers must never see those component lines or their per-item
 * allocated prices; they must see exactly ONE row per box: name, quantity,
 * and the bundle's price (the sum of the group's line totals, which — by
 * the allocation invariant — equals the bundle price exactly). Admin,
 * picking, and returns render the real component lines directly and must
 * NOT use this helper.
 *
 * `bundleName`/`bundleNameAr` are snapshotted onto the order at checkout
 * time (like `productName`/`costPrice` already are) — this helper renders
 * them as-is. It never re-fetches or trusts a "current" bundle name, so a
 * bundle renamed or deleted after the order still shows the name the
 * customer actually bought.
 *
 * Shared between the storefront (cart/checkout/order views) and the API's
 * invoice generator so both surfaces collapse a box the same way, from one
 * implementation.
 */

export interface OrderLineBase {
  id: string;
  quantity: number;
  price: number;
  bundleGroupId?: string | null;
  bundleName?: string | null;
  bundleNameAr?: string | null;
}

export type OrderDisplayLine<T extends OrderLineBase> =
  | { kind: 'item'; key: string; item: T }
  | {
      kind: 'bundle';
      key: string;
      bundleGroupId: string;
      name: string;
      nameAr: string | null;
      /** Always 1 — a `bundleGroupId` is exactly one box; buying N boxes
       *  produces N separate groups (and thus N separate rows), never one
       *  row with quantity N. */
      quantity: number;
      /** Sum of the group's line totals — the bundle's price, never the
       *  per-line allocated shares. */
      total: number;
      /** The raw component lines this row summarizes. NEVER render these
       *  individually on a customer-facing surface — pass them to an
       *  admin/picking view instead. */
      lines: T[];
    };

export function groupOrderLinesForDisplay<T extends OrderLineBase>(
  items: readonly T[]
): OrderDisplayLine<T>[] {
  const result: OrderDisplayLine<T>[] = [];
  const groupIndex = new Map<string, number>();

  for (const item of items) {
    if (item.bundleGroupId) {
      const idx = groupIndex.get(item.bundleGroupId);
      if (idx === undefined) {
        groupIndex.set(item.bundleGroupId, result.length);
        result.push({
          kind: 'bundle',
          key: item.bundleGroupId,
          bundleGroupId: item.bundleGroupId,
          // A box with no snapshotted name in either language still reads in the
          // shopper's language: 'Bundle' / 'باقة', never an English word in Arabic.
          name: item.bundleName || item.bundleNameAr || 'Bundle',
          nameAr: item.bundleNameAr || (item.bundleName ? null : 'باقة'),
          quantity: 1,
          total: item.price * item.quantity,
          lines: [item],
        });
      } else {
        const existing = result[idx];
        if (existing.kind === 'bundle') {
          existing.total += item.price * item.quantity;
          existing.lines.push(item);
        }
      }
    } else {
      result.push({ kind: 'item', key: item.id, item });
    }
  }

  return result;
}

/**
 * An order line's variant title in the reader's language (Ruling B0-41): `variantNameAr`
 * (the Arabic snapshot) when reading Arabic, else `variantName` (the canonical title), each
 * falling back to the other. Customer-facing surfaces pass the shopper's language; admin,
 * the orders PWA and pick lists pass the admin locale. Fiscal documents and CSV exports do
 * NOT use this: they print `variantName` exactly as before.
 */
export function orderLineVariantTitle(
  item: { variantName?: string | null; variantNameAr?: string | null },
  ar: boolean
): string | null {
  return (
    (ar ? item.variantNameAr || item.variantName : item.variantName || item.variantNameAr) || null
  );
}

/**
 * A variant title ("وردي / M / 54 سم") split into its option values, for rendering each
 * value in its own `<bdi>` (see `VariantText` in @ebda/ui). As one bidi run, mixed Arabic and
 * Latin values reorder: "وردي / M / 54 سم" displayed as "وردي / 54 / M سم" (F8).
 */
export function variantTitleSegments(title: string): string[] {
  return title
    .split(' / ')
    .map(s => s.trim())
    .filter(Boolean);
}
