import { z } from 'zod/v3';
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from '../resolve-store';
import { CartService, type CartBundleView } from '../../services/cart.service';
import { retailUnitPrice } from '../../lib/cart-pricing';
import {
  agentContextFrom,
  assertAgentWrite,
  auditAgentWrite,
  MCP_ID_MAX_CHARS,
} from '../agent-auth';
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
 *   - Unit price uses the shared `retailUnitPrice` helper (variant price
 *     wins when a variant is chosen, nullish-coalescing so a free variant
 *     priced at 0 doesn't fall through to the parent price) — the same
 *     helper the cart/order subtotal math uses, so the tool's line price can
 *     never drift from what the store actually charges.
 *   - `cart.subtotal` — computed by the service, integer piastres.
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
      note: item.note ?? undefined,
      title: item.product?.name,
      title_ar: item.product?.nameAr ?? undefined,
      quantity: item.quantity,
      // Server-resolved by the cart service (anonymous buyer for MCP: retail + public tiers); an unavailable line carries
      // no resolved price and shows its retail shelf price.
      unitPrice: typeof item.unitPrice === 'number' ? item.unitPrice : retailUnitPrice(item),
      // #1766: the product was deleted — this line is excluded from
      // `subtotal` and blocks checkout until it is removed.
      ...(item.unavailable ? { unavailable: true } : {}),
      // Gold-rate pricing (Ruling B5-17): the gold rate moved since the line was added. `place_order` with
      // `acknowledgePrices: true` accepts the new price.
      ...(item.priceChanged
        ? { priceChanged: true, previousUnitPrice: item.previousUnitPrice }
        : {}),
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
        "Add a product (optionally a specific variant) to a cart. Omit cartId to start a new cart — the returned cartId must be reused for later cart/checkout calls. WRITE TOOL: requires the store's agent credential in the `x-agent-key` header.",
      inputSchema: {
        // `.max()` is not cosmetic here: the denied-write audit below persists
        // `productId` verbatim and runs BEFORE the credential check, so an
        // unbounded string would let an anonymous caller write the ~10mb body
        // limit into `audit_logs` 300×/min/IP. See `MCP_ID_MAX_CHARS`.
        cartId: z.string().min(1).max(MCP_ID_MAX_CHARS).optional(),
        productId: z.string().min(1).max(MCP_ID_MAX_CHARS),
        variantId: z.string().min(1).max(MCP_ID_MAX_CHARS).optional(),
        quantity: z.number().int().min(1).max(999),
        // Personalisation text (e.g. a name to embroider) for products that take one;
        // a product with personalisation off ignores it. 400 here, cleaned + capped at 200.
        note: z.string().max(400).optional(),
      },
    },
    async ({ cartId, productId, variantId, quantity, note }, extra) => {
      // WRITE GATE. `add_to_cart` commits no money and no inventory, but it
      // creates unbounded Cart/CartItem rows for an unauthenticated caller AND
      // it is the only way to mint the cartId `place_order` consumes — so it
      // is gated with `place_order` rather than left as the open on-ramp to
      // the money path. Reads stay anonymous. Throws inside the handler (not
      // at the Express layer) so the refusal reaches the agent as an
      // explained tool error, never as a 401 that would also kill the
      // handshake and every read tool.
      let context;
      try {
        context = assertAgentWrite('add_to_cart', extra);
      } catch (err) {
        await auditAgentWrite({
          store,
          tool: 'add_to_cart',
          outcome: 'denied',
          context: agentContextFrom(extra),
          details: { productId },
        });
        throw err;
      }

      const sessionId = cartId ?? newCartId();
      try {
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
          variantId,
          note
        );
        return ok(cartView(sessionId, cart, store.currency));
      } catch (err) {
        // A rejected write is the signal worth the most and the one nothing
        // recorded before — this file wrote zero audit rows.
        await auditAgentWrite({
          store,
          tool: 'add_to_cart',
          outcome: 'failed',
          context,
          details: { productId, variantId, quantity, error: (err as Error).message },
        });
        throw err;
      }
    }
  );

  server.registerTool(
    'view_cart',
    {
      description:
        "View a cart's items, bundles, and subtotal by its cartId. `bundles` are boxes the store sells at a fixed price — each is one entry, never split into its component products.",
      // Same bound as `add_to_cart`'s ids, same discipline on a different
      // table: `CartService.view` is read-only (#1661 — it used to be
      // `getOrCreate`, which mints a Cart row on ANY miss with this exact
      // string as its `sessionId`, making an anonymous read a write
      // amplifier), but an unbounded string is still worth capping here on
      // general principle. Every cartId in circulation is `sess_` + 32 hex
      // (minted by `add_to_cart` or `apps/web/src/lib/api.ts`), far inside
      // the cap.
      inputSchema: { cartId: z.string().min(1).max(MCP_ID_MAX_CHARS) },
    },
    async ({ cartId }) => {
      const cart = await CartService.view(store.id, cartId);
      return ok(cartView(cartId, cart, store.currency));
    }
  );
}
