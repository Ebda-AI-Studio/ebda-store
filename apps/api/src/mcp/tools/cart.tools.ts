import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from '../resolve-store';
import { CartService } from '../../services/cart.service';
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
 */
function cartView(cartId: string, cart: any, currency: string) {
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
      description: "View a cart's items and subtotal by its cartId.",
      inputSchema: { cartId: z.string().min(1) },
    },
    async ({ cartId }) => {
      const cart = await CartService.getOrCreate(store.id, cartId);
      return ok(cartView(cartId, cart, store.currency));
    }
  );
}
