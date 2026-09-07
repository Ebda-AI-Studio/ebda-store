import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from '../resolve-store';
import { CartService, type CartBundleView } from '../../services/cart.service';
import { cartLineUnitPrice } from '../../lib/cart-pricing';
import { ok } from './tool-result';

/**
 * `CartService.getOrCreate`/`addItem` return `{ ...cart, subtotal }` where
 * `cart.items[]` is populated via the storefront-safe include in
 * `cart.service.ts` (`STOREFRONT_PRODUCT_SELECT` + a narrow variant select) —
 * confirmed against the real service, not guessed:
 *   - `item.id` / `item.productId` / `item.variantId` / `item.quantity` — raw
 *     CartItem columns.
 *   - `item.product.name` / `item.product.nameAr` — bilingual product name
 *     (same convention as catalog.tools.ts's `toSummary`).
 *   - `item.variant.title` (NOT `.name`) — `ProductVariant.title` is the real
 *     column (`cart.service.ts`'s include selects `{ id, title, titleAr,
 *     price }`); catalog.tools.ts's `.name` rename only applies to the
 *     product-DETAIL variant shape from `reshapePublicProductDetail`, which
 *     this cart include does not go through.
 *   - Unit price uses the shared `cartLineUnitPrice` helper (variant price
 *     wins when a variant is chosen, nullish-coalescing so a free variant
 *     priced at 0 doesn't fall through to the parent price) — the same
 *     helper the cart/order subtotal math uses, so the tool's line price can
 *     never drift from what the store actually charges.
 *   - `cart.subtotal` — computed by the service, integer fils.
 *   - No `currency` column on Cart/CartItem/Product — read from
 *     `store.currency` (the `McpStore` passed into `registerCartTools`),
 *     confirmed absent from `STOREFRONT_PRODUCT_SELECT` (Task 4 finding,
 *     re-verified here against `schema.prisma`).
 *
 * A bundle in the cart is a THIRD, separate line kind (see `cart.service.ts`):
 * `CartBundle` rows are never expanded into `cart.items` — each is already
 * ONE row per box, priced live via `resolveBundle`. `getOrCreate`/`addItem`
 * return it pre-resolved as `cart.bundles: CartBundleView[]` and roll it into
 * `cart.subtotal` (`itemsSubtotal + bundlesSubtotal`). This view used to map
 * `cart.items` only and silently drop `cart.bundles` — an agent reading
 * `view_cart` never saw a bundle it (or a human sharing the same cart
 * session) had added, and `subtotal` no longer reconciled to the sum of the
 * listed lines with no line explaining the gap. `bundles` below is additive:
 * a cart with none renders `bundles: []`, `items` unchanged.
 */
export function cartView(cartId: string, cart: any, currency: string) {
  return {
    cartId,
    items: cart.items.map((item: any) => ({
      itemId: item.id,
      productId: item.productId,
      variantId: item.variantId ?? undefined,
      title: item.product?.name,
      title_ar: item.product?.nameAr ?? undefined,
      quantity: item.quantity,
      unitPrice: cartLineUnitPrice(item),
    })),
    bundles: (cart.bundles ?? []).map((b: CartBundleView) => ({
      cartBundleId: b.id,
      bundleId: b.bundleId,
      title: b.name,
      title_ar: b.nameAr ?? undefined,
      quantity: b.quantity,
      unitPrice: b.unitPrice,
      total: b.total,
    })),
    subtotal: cart.subtotal,
    currency,
  };
}

const newCartId = () => `sess_${randomBytes(16).toString('hex')}`;

export function registerCartTools(server: McpServer, store: McpStore): void {
  server.registerTool(
    'add_to_cart',
    {
      description:
        'Add a product (optionally a specific variant) to a cart. Omit cartId to start a new cart — the returned cartId must be reused for later cart/checkout calls.',
      inputSchema: {
        cartId: z.string().min(1).optional(),
        productId: z.string().min(1),
        variantId: z.string().min(1).optional(),
        quantity: z.number().int().min(1).max(999),
      },
    },
    async ({ cartId, productId, variantId, quantity }) => {
      const sessionId = cartId ?? newCartId();
      // Throws AppError (404 NOT_FOUND for an unknown product/variant, 400
      // INSUFFICIENT_INVENTORY on oversell) — left to propagate so the SDK
      // converts it into `{ isError: true }` rather than a 500 (same pattern
      // as `get_product` in catalog.tools.ts).
      const cart = await CartService.addItem(
        store.id,
        sessionId,
        productId,
        quantity,
        undefined,
        variantId
      );
      return ok(cartView(sessionId, cart, store.currency));
    }
  );

  server.registerTool(
    'view_cart',
    {
      description:
        "View a cart's items, bundles, and subtotal by its cartId. `bundles` are boxes the store sells at a fixed price — each is one entry, never split into its component products.",
      inputSchema: { cartId: z.string().min(1) },
    },
    async ({ cartId }) => {
      const cart = await CartService.getOrCreate(store.id, cartId);
      return ok(cartView(cartId, cart, store.currency));
    }
  );
}
