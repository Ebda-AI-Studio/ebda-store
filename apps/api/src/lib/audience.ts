/**
 * Product audience (B2B Ruling B2B-7b; B2B-1b: a RESTRICTION, so it survives a plan downgrade).
 *
 * `products.audience = 'wholesale_only'` removes the product from every anonymous surface: public list, search (the raw SQL
 * predicate sits BEFORE the LIMIT in lib/search), suggestions, filters, categories counts, recommendations, feeds / MCP / WA
 * (all built from the same public queries), wishlist, cart add (404, no existence oracle) and order creation. Only a buyer who
 * is a member of an ACTIVE wholesale group (customers.user_id link, or a merchant's explicit pick) can see or buy it, through
 * the authenticated no-store routes. This module is the one place that decides "member".
 */
import { loadBuyerGroup } from '../services/price-resolver.service';
import type { BuyerIdentity } from './buyer-identity';

/** Prisma `where` fragment for every anonymous product query. */
export const PUBLIC_AUDIENCE = { audience: 'public' } as const;

/** True for a buyer in an active wholesale group. Anonymous buyers are never members. */
export async function canSeeWholesaleOnly(storeId: string, buyer: BuyerIdentity): Promise<boolean> {
  if (buyer.kind === 'anonymous') return false;
  const g = await loadBuyerGroup(storeId, buyer);
  return !!g && g.isWholesale && g.isActive;
}
