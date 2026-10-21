/**
 * BuyerIdentity - who a price is for. docs/plans/2026-10-21-b2b-wholesale.md, design review I7 + Rulings B2B-2c / B2B-2d.
 *
 * A branded type: an object literal such as `{ kind: 'session', userId }` does NOT type-check as a BuyerIdentity, because
 * the brand symbol is not exported. The ONLY ways to obtain one are the three factories below, which are the only places
 * the identity may come from:
 *   - `ANONYMOUS_BUYER`                    guests, WhatsApp-bot sessions, payment-link payers, MCP catalogue, feeds
 *   - `buyerFromRequest(req)`              the verified customer SESSION (customerUserId), never a body / query / header
 *   - `buyerFromMerchantSelection(req, id)` a merchant staff session choosing a Customer by id (admin order, payment link)
 * `tests/unit/b2b-buyer-identity.test.ts` fails on any `kind: 'session'` / `'merchant-selected'` literal outside this file.
 * A phone number or an email address is not an input to any factory, by construction.
 */
import type { Request } from 'express';
import { customerUserId } from '../middleware/auth';

declare const buyerBrand: unique symbol;

type Brand = { readonly [buyerBrand]: true };

export type BuyerIdentity =
  | (Brand & { readonly kind: 'anonymous' })
  | (Brand & { readonly kind: 'session'; readonly userId: string })
  | (Brand & {
      readonly kind: 'merchant-selected';
      readonly customerId: string;
      readonly actorUserId: string;
    });

export const ANONYMOUS_BUYER = Object.freeze({ kind: 'anonymous' }) as BuyerIdentity;

/** The signed-in CUSTOMER of this request, else anonymous. A merchant / staff / admin token is anonymous here. */
export function buyerFromRequest(req: Request): BuyerIdentity {
  const userId = customerUserId(req);
  if (!userId) return ANONYMOUS_BUYER;
  return Object.freeze({ kind: 'session', userId }) as BuyerIdentity;
}

const MERCHANT_ROLES = new Set(['store_admin', 'super_admin', 'staff']);

/**
 * A merchant (store admin / staff / super admin) pricing an order or payment link for the Customer they picked BY ID.
 * Call only after `requireStoreAccess`. Throws when the request is not a merchant session, so a shopper token can never
 * mint one. `customerId` must come from the merchant's explicit selection, never from a phone / email lookup.
 */
export function buyerFromMerchantSelection(req: Request, customerId: string): BuyerIdentity {
  const actor = req.user;
  if (!actor || !MERCHANT_ROLES.has(actor.role) || !actor.userId) {
    throw new Error('buyerFromMerchantSelection: a merchant session is required');
  }
  if (!customerId) throw new Error('buyerFromMerchantSelection: customerId is required');
  return Object.freeze({
    kind: 'merchant-selected',
    customerId,
    actorUserId: actor.userId,
  }) as BuyerIdentity;
}
