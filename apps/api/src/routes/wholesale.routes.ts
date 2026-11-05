/**
 * Wholesale account routes (B2B Task 5).
 *   shopper  POST /public/wholesale/apply, GET /public/wholesale/status   (customer session; rate-limited; no-store)
 *   merchant GET/POST /stores/:storeId/wholesale-applications[/:id/(approve|reject|revoke)]
 *            authenticate -> authorize(store_admin, super_admin) -> requireStoreAccess -> requireFeature on decisions
 * The applicant is ALWAYS the signed-in customer (customerUserId); a body can never name another user. Zod `.strict()`.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { storeDb } from '../lib/repo-factory';
import { z } from 'zod/v3';
import {
  authenticate,
  authorize,
  optionalAuthenticate,
  customerUserId,
  rejectImpersonated,
} from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { tenantContext } from '../middleware/tenant-context';
import { writeLimiter } from '../middleware/security';
import { getStoreIdFromRequest, getAuthUser } from '../utils/store-helpers';
import { setBuyerPrivate } from '../lib/edge-cache';
import { WholesaleApplicationService } from '../services/wholesale-application.service';
import { AppError } from '../middleware/error-handler';
import { prisma } from '@ebda/database';
import { cartLimiter } from '../middleware/security';
import { buyerFromRequest } from '../lib/buyer-identity';
import { canSeeWholesaleOnly } from '../lib/audience';
import { PriceResolver } from '../services/price-resolver.service';
import { ProductService } from '../services/product.service';

export const publicWholesaleRouter = Router();
export const merchantWholesaleRouter = Router();
merchantWholesaleRouter.param('storeId', tenantContext);

const applySchema = z
  .object({
    businessName: z.string().trim().min(2).max(160),
    commercialRegNo: z.string().trim().max(60).nullish(),
    phone: z.string().trim().min(6).max(40),
    notes: z.string().trim().max(1000).nullish(),
    // The form shows the data notice; the applicant must accept it and the server stamps `consent_at` (review M1).
    consent: z.literal(true),
  })
  .strict();

function requireCustomer(req: Request): string {
  const id = customerUserId(req);
  if (!id) throw new AppError(401, 'UNAUTHORIZED', 'Sign in to continue');
  return id;
}

publicWholesaleRouter.post(
  '/wholesale/apply',
  optionalAuthenticate,
  // An impersonation session must not apply as the customer (design review I5).
  rejectImpersonated,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      setBuyerPrivate(res);
      const userId = requireCustomer(req);
      const storeId = await getStoreIdFromRequest(req);
      const body = applySchema.parse(req.body);
      const application = await WholesaleApplicationService.apply(storeId, userId, body);
      res.status(201).json({ success: true, data: { application } });
    } catch (e) {
      next(e);
    }
  }
);

publicWholesaleRouter.get('/wholesale/status', optionalAuthenticate, async (req, res, next) => {
  try {
    setBuyerPrivate(res);
    const userId = requireCustomer(req);
    const storeId = await getStoreIdFromRequest(req);
    const out = await WholesaleApplicationService.status(storeId, userId);
    setBuyerPrivate(res);
    res.json({ success: true, data: out });
  } catch (e) {
    next(e);
  }
});

// ── POST /public/pricing/resolve: the signed-in buyer's price for specific quantities (PDP tier table, cart preview) ──
// Buyer-specific, so it is `private, no-store` and never cached. Buyer = the SESSION only (buyerFromRequest). Items name a
// product / variant / quantity and NOTHING ELSE: a price in the body is a 400 (strict). A wholesale-only product is resolved
// only for an approved member; for anyone else it is simply absent from the answer (no existence oracle).
const resolveSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            productId: z.string().uuid(),
            variantId: z.string().uuid().nullish(),
            qty: z.number().int().min(1).max(100_000),
          })
          .strict()
      )
      .min(1)
      .max(50),
  })
  .strict();

publicWholesaleRouter.post(
  '/pricing/resolve',
  optionalAuthenticate,
  cartLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = await getStoreIdFromRequest(req);
      const { items } = resolveSchema.parse(req.body);
      const buyer = buyerFromRequest(req);
      setBuyerPrivate(res);
      const member = await canSeeWholesaleOnly(storeId, buyer);
      const products = await (
        await storeDb(storeId)
      ).product.findMany({
        where: {
          id: { in: [...new Set(items.map(i => i.productId))] },
          storeId,
          status: 'active',
          deletedAt: null,
          ...(member ? {} : { audience: 'public' }),
        },
        select: {
          id: true,
          price: true,
          moq: true,
          variants: { select: { id: true, price: true } },
        },
      });
      const byId = new Map(products.map(p => [p.id, p]));
      const lines = items.flatMap((it, i) => {
        const p = byId.get(it.productId);
        if (!p) return [];
        const v = it.variantId ? p.variants.find(x => x.id === it.variantId) : undefined;
        if (it.variantId && !v) return [];
        return [
          {
            key: String(i),
            item: it,
            product: { id: p.id, price: p.price, moq: p.moq },
            variant: v ? { id: v.id, price: v.price } : null,
          },
        ];
      });
      // Each requested quantity is priced on its own (one resolver per call, no cross-item summing: these are quotes for a tier
      // table, not a cart).
      const resolver = await PriceResolver.forBuyer(storeId, buyer);
      const out = [];
      for (const l of lines) {
        const r = await resolver.priceLine(l.product, l.variant, l.item.qty);
        out.push({
          productId: l.item.productId,
          variantId: l.item.variantId ?? null,
          qty: l.item.qty,
          unitPrice: r.unitMinor,
          listPrice: r.listMinor,
          priceSource: r.source,
          priceTierMinQty: r.tierMinQty,
          belowMoq: r.belowMoq,
          moqRequired: r.moqRequired,
        });
      }
      res.json({ success: true, data: { prices: out } });
    } catch (e) {
      next(e);
    }
  }
);

// ── GET /public/wholesale/products[/:slug]: the approved buyer's extra catalogue (wholesale-only products) ──
// Members only; everyone else gets a plain 404 (never a 403: no existence oracle). private, no-store.
const catalogQuery = z.object({
  page: z.coerce.number().int().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
publicWholesaleRouter.get(
  '/wholesale/products',
  optionalAuthenticate,
  cartLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = await getStoreIdFromRequest(req);
      setBuyerPrivate(res);
      if (!(await canSeeWholesaleOnly(storeId, buyerFromRequest(req)))) {
        throw new AppError(404, 'NOT_FOUND', 'Not found');
      }
      const q = catalogQuery.parse(req.query);
      const data = await ProductService.listPublic(storeId, { ...q, audience: 'wholesale_only' });
      res.json({ success: true, data });
    } catch (e) {
      next(e);
    }
  }
);
publicWholesaleRouter.get(
  '/wholesale/products/:slug',
  optionalAuthenticate,
  cartLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = await getStoreIdFromRequest(req);
      setBuyerPrivate(res);
      if (!(await canSeeWholesaleOnly(storeId, buyerFromRequest(req)))) {
        throw new AppError(404, 'NOT_FOUND', 'Not found');
      }
      const product = await ProductService.getPublicBySlug(storeId, req.params.slug, {
        audience: 'wholesale_only',
      });
      res.json({ success: true, data: { product } });
    } catch (e) {
      next(e);
    }
  }
);

const guard = [authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess];
const base = '/:storeId/wholesale-applications';
const listSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'revoked']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().uuid().optional(),
});
const approveSchema = z.object({ groupId: z.string().uuid() }).strict();
const noteSchema = z.object({ note: z.string().trim().max(500).nullish() }).strict();

merchantWholesaleRouter.get(
  base,
  ...guard,
  requireFeature('b2b.wholesale'), // BE:S-29 / D7
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = listSchema.parse(req.query);
      res.json({
        success: true,
        data: await WholesaleApplicationService.list(req.params.storeId, q),
      });
    } catch (e) {
      next(e);
    }
  }
);

// Pending count + age of the oldest pending application: feeds the merchant badge and the 48h nudge (review I5).
merchantWholesaleRouter.get(
  `${base}/summary`,
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        success: true,
        data: await WholesaleApplicationService.summary(req.params.storeId),
      });
    } catch (e) {
      next(e);
    }
  }
);

merchantWholesaleRouter.post(
  `${base}/:id/approve`,
  ...guard,
  requireFeature('b2b.wholesale'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupId } = approveSchema.parse(req.body);
      const application = await WholesaleApplicationService.approve(
        req.params.storeId,
        req.params.id,
        groupId,
        getAuthUser(req).userId
      );
      res.json({ success: true, data: { application } });
    } catch (e) {
      next(e);
    }
  }
);

merchantWholesaleRouter.post(
  `${base}/:id/reject`,
  ...guard,
  requireFeature('b2b.wholesale'), // BE:S-29 / D7 (revoke / lapse stay open: a downgraded merchant can still end access)
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { note } = noteSchema.parse(req.body ?? {});
      const application = await WholesaleApplicationService.reject(
        req.params.storeId,
        req.params.id,
        note ?? null,
        getAuthUser(req).userId
      );
      res.json({ success: true, data: { application } });
    } catch (e) {
      next(e);
    }
  }
);

merchantWholesaleRouter.post(
  `${base}/:id/revoke`,
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { note } = noteSchema.parse(req.body ?? {});
      const { membership, ...application } = await WholesaleApplicationService.revoke(
        req.params.storeId,
        req.params.id,
        note ?? null,
        getAuthUser(req).userId
      );
      // `membership` tells the merchant whether the buyer was actually moved out of wholesale (never a silent no-op).
      res.json({ success: true, data: { application, membership } });
    } catch (e) {
      next(e);
    }
  }
);
