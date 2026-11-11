/**
 * Redeem a `/cart/from-wa?t=` checkout link (Ruling WA-RPC-3, closes WA-RPC-F1): copy the token's lines into THIS visitor's session
 * cart. The signed, 30-minute, store-bound token is the only capability and carries ids and quantities, never a price: the cart
 * re-prices every line from the Store's own rows. Idempotent (a line already in the cart is not added again), so a refresh or a
 * double mount never doubles a quantity. The buyer key stays inside the token; nothing about the buyer is returned.
 */
import { storeDb } from '../../repo-factory';
import { CartService } from '../../../services/cart.service';
import { verifyCheckoutToken } from './checkout-token';

export type RedeemResult =
  | { redeemed: true; added: number; unavailable: number }
  | { redeemed: false; reason: 'invalid' };

export async function redeemWaCheckout(
  storeId: string,
  token: unknown,
  sessionId: string,
  customerId?: string
): Promise<RedeemResult> {
  const p = verifyCheckoutToken(token);
  if (!p || p.storeId !== storeId) return { redeemed: false, reason: 'invalid' };
  const db = await storeDb(storeId);
  const ids = p.items.map(i => i.variantId);
  const [variants, simple] = await Promise.all([
    db.productVariant.findMany({
      where: { id: { in: ids }, isActive: true, product: { storeId, deletedAt: null } },
      select: { id: true, productId: true },
    }),
    db.product.findMany({
      where: { storeId, id: { in: ids }, deletedAt: null, status: 'active' },
      select: { id: true },
    }),
  ]);
  const vProduct = new Map(variants.map(v => [v.id, v.productId]));
  const simpleIds = new Set(simple.map(s => s.id));
  const lines: Array<{ productId: string; variantId?: string; quantity: number }> = [];
  let unavailable = 0;
  for (const it of p.items) {
    const productId = vProduct.get(it.variantId);
    if (productId) lines.push({ productId, variantId: it.variantId, quantity: it.quantity });
    else if (simpleIds.has(it.variantId))
      lines.push({ productId: it.variantId, quantity: it.quantity });
    else unavailable += 1;
  }
  const mine = await db.cart.findFirst({ where: { storeId, sessionId }, select: { id: true } });
  const have = new Set(
    mine
      ? (
          await db.cartItem.findMany({
            where: { cartId: mine.id },
            select: { productId: true, variantId: true },
          })
        ).map(i => `${i.productId}:${i.variantId ?? ''}`)
      : []
  );
  const missing = lines.filter(l => !have.has(`${l.productId}:${l.variantId ?? ''}`));
  if (missing.length > 0) await CartService.addItems(storeId, sessionId, missing, customerId);
  return { redeemed: true, added: missing.length, unavailable };
}
