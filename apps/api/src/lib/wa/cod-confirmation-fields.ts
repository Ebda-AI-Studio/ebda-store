import { orderAddressLines, storefrontOrigin } from '@ebda/shared';

/**
 * The extra, optional fields of `order.cod_confirmation_requested` (contract v1.6) that let Ebda Chat send the
 * richer COD message: store name header, delivery address, item count and a button to the order page.
 *
 * PII: `shippingAddressLine` goes only to the customer who placed the order (the same phone the event is for).
 * Nothing here logs; callers must never put it in a log line.
 *
 * The order link is `o/<token>`: a signed, expiring (14 days), single-order token (lib/order-status-link-token.ts)
 * that opens a minimal read-only summary a guest can see: no phone, email or street, never cached or indexed. The
 * guest view token (SEC-15) never travels in a URL.
 */
type CodConfirmationFields = {
  storeName?: string;
  shippingAddressLine?: string;
  itemCount?: number;
  orderUrlSuffix?: string;
  storefrontOrigin?: string;
};

const MAX_STORE_NAME = 60; // Meta's text-header limit
const MAX_ADDRESS = 300;

/** One line, single spaces: WhatsApp template parameters refuse newlines, tabs and runs of spaces. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function codConfirmationFields(input: {
  /** Path under the storefront origin that opens the guest-safe order summary, e.g. `o/<token>`. */
  orderUrlSuffix: string;
  locale: string;
  shippingAddress: unknown;
  items: ReadonlyArray<{ quantity: number }> | null | undefined;
  store:
    | { name: string; nameAr?: string | null; slug: string; domain?: string | null }
    | null
    | undefined;
}): CodConfirmationFields {
  const out: CodConfirmationFields = {};
  const ar = input.locale.toLowerCase().startsWith('ar');
  const { store } = input;
  if (store) {
    const name = oneLine((ar && store.nameAr) || store.name || '').slice(0, MAX_STORE_NAME);
    if (name) out.storeName = name;
    out.storefrontOrigin = storefrontOrigin({ slug: store.slug, domain: store.domain ?? null });
  }
  const addr = oneLine(
    orderAddressLines(
      (input.shippingAddress ?? {}) as Record<string, unknown>,
      ar ? 'ar' : 'en'
    ).join(ar ? '، ' : ', ')
  ).slice(0, MAX_ADDRESS);
  if (addr) out.shippingAddressLine = addr;
  const count = (input.items ?? []).reduce(
    (n, i) => n + (Number.isInteger(i.quantity) && i.quantity > 0 ? i.quantity : 0),
    0
  );
  if (count > 0) out.itemCount = Math.min(count, 9999);
  out.orderUrlSuffix = input.orderUrlSuffix;
  return out;
}
