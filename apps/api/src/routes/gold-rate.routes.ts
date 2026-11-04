import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod/v3';
import {
  GOLD_DEFERRED_EXPLANATION,
  goldAllowsDeferredPayment,
  goldRateInputSchema,
  goldRateSettingsSchema,
  productGoldPricingInputSchema,
  variantGoldPricingInputSchema,
} from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { writeLimiter } from '../middleware/security';
import { requireStoreAccess } from '../middleware/store-access';
import { GoldRateService } from '../services/gold-rate/gold-rate.service';
import { StoreService } from '../services/store.service';
import { auditLog } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';

/**
 * Gold-rate pricing (Phase B5 Task 10; Rulings B5-13, B5-20): /stores/:storeId/gold-rates, mounted
 * under `tenantContext` beside the size-chart routes.
 *
 *   GET  /                        current rates + settings + pending     products:read
 *   GET  /history                 audited rate history (cursor)          products:read
 *   PUT  /                        write 1..3 rates                       store:settings
 *   POST /:rateId/decision        confirm / reject a pending feed rate   store:settings
 *   PUT  /settings                rates settings                         store:settings
 *   GET  /payment-policy          "allow COD / installments for gold"    products:read
 *   PUT  /payment-policy          same switch, ON needs confirm (SHARIA-GOLD-1)  store:settings
 *   PUT  /products/:productId/pricing   a product's mode + spec          products:write
 *   POST /bulk/pricing-mode       switch many products                   store:settings
 *
 * `staff` has `products:write` but NOT `store:settings` (rbac.ts), so a rate, a setting or the bulk
 * switch is the owner's and a per-product spec follows `products:write`, like the fixed price staff
 * can already edit. Every body is a STRICT Zod object: an unknown key (a client-supplied price) is a 400.
 */
const router = Router({ mergeParams: true });

const base = [
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
] as const;
const readChain = [...base, requirePermission('products:read')] as const;
const productWriteChain = [...base, requirePermission('products:write'), writeLimiter] as const;
const settingsChain = [...base, requirePermission('store:settings'), writeLimiter] as const;

/**
 * Re-throw a schema failure as THIS module's ZodError so it is the standard 400 whichever zod copy
 * built the schema (the dual-zod class, see size-chart.routes.ts).
 */
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ZodError(parsed.error.issues as z.ZodIssue[]);
  return parsed.data;
}

const idSchema = z.string().uuid();
const decisionSchema = z.object({ decision: z.enum(['confirm', 'reject']) }).strict();
const historyQuery = z
  .object({
    karat: z.coerce
      .number()
      .int()
      .refine(k => [24, 21, 18].includes(k))
      .optional(),
    cursor: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
const productPricingBody = z
  .object({
    product: productGoldPricingInputSchema,
    // each slice (id + spec fields) is validated by its own STRICT schema below, never passed through
    variants: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
  })
  .strict();
const bulkBody = z
  .object({
    productIds: z.array(z.string().uuid()).min(1).max(500),
    mode: z.enum(['fixed', 'gold_rate']),
  })
  .strict();

router.get('/', ...readChain, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await GoldRateService.getState(req.params.storeId) });
  } catch (error) {
    next(error);
  }
});

router.get('/history', ...readChain, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = parse(historyQuery, req.query);
    res.json({
      success: true,
      data: await GoldRateService.history(req.params.storeId, {
        karat: q.karat as 24 | 21 | 18 | undefined,
        cursor: q.cursor,
        limit: q.limit,
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.put('/', ...settingsChain, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parse(goldRateInputSchema, req.body);
    const result = await GoldRateService.applyRates(req.params.storeId, input, {
      userId: req.user!.userId,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.put(
  '/settings',
  ...settingsChain,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = parse(goldRateSettingsSchema, req.body);
      const result = await GoldRateService.updateSettings(req.params.storeId, input, {
        userId: req.user!.userId,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

const paymentPolicyBody = z
  .object({ allowDeferred: z.boolean(), confirm: z.boolean().optional() })
  .strict();

router.get(
  '/payment-policy',
  ...readChain,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = await StoreService.getById(req.params.storeId);
      res.json({
        success: true,
        data: { allowDeferred: goldAllowsDeferredPayment(store.settings) },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/payment-policy',
  ...settingsChain,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = parse(paymentPolicyBody, req.body);
      // Turning COD / installments ON for gold is the risky direction: it needs the explicit confirm,
      // checked here and not only in the admin dialog. Turning it OFF never does.
      if (input.allowDeferred && input.confirm !== true) {
        res.status(400).json({
          success: false,
          error: {
            code: 'CONFIRM_REQUIRED',
            message: GOLD_DEFERRED_EXPLANATION.en,
          },
        });
        return;
      }
      await StoreService.setGoldAllowDeferredPayment(req.params.storeId, input.allowDeferred);
      await auditLog({
        action: 'store.gold_allow_deferred_payment',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: req.params.storeId,
        storeId: req.params.storeId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        details: { allowDeferred: input.allowDeferred },
      });
      res.json({ success: true, data: { allowDeferred: input.allowDeferred } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/bulk/pricing-mode',
  ...settingsChain,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parse(bulkBody, req.body);
      const result = await GoldRateService.bulkSwitchMode(
        req.params.storeId,
        body.productIds,
        body.mode,
        { userId: req.user!.userId }
      );
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/products/:productId/pricing',
  ...productWriteChain,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const productId = parse(idSchema, req.params.productId);
      const body = parse(productPricingBody, req.body);
      // each variant slice is validated by its own strict schema inside the service
      const variants = (body.variants ?? []).map(v => {
        const { id, ...rest } = v;
        return { id: parse(idSchema, id), ...parse(variantGoldPricingInputSchema, rest) };
      });
      const result = await GoldRateService.setProductPricing(
        req.params.storeId,
        productId,
        { product: body.product, variants },
        { userId: req.user!.userId }
      );
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:rateId/decision',
  ...settingsChain,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rateId = parse(idSchema, req.params.rateId);
      const { decision } = parse(decisionSchema, req.body);
      const result = await GoldRateService.decidePending(req.params.storeId, rateId, decision, {
        userId: req.user!.userId,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
