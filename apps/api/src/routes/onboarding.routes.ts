import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireVerifiedEmail } from '../middleware/require-verified-email';
import { tenantContext } from '../middleware/tenant-context';
import { auditLog, writeLimiter } from '../middleware/security';
import { withUser } from '@ebda/database';
import { parseInput } from '../lib/parse-input';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { getAuthUser } from '../utils/store-helpers';
import {
  fileSlugClaim,
  fileStoreCapRequest,
  notifyStaff,
  type TrustDb,
} from '../services/trust-requests.service';
import { OnboardingService } from '../services/onboarding.service';
import { createStoreSchema } from './onboarding.schemas';
import { applyOnboardingInstapay } from '../services/onboarding-instapay';
import { toSafeStoreResponse } from '../lib/store-response';

/**
 * Self-serve onboarding, mounted at `/onboarding`.
 *
 * Authorization on every route: authenticate -> authorize -> (store routes)
 * requireStoreAccess. Store creation and go-live additionally need a verified
 * email (`requireVerifiedEmail`, checked against the DB). Public signup and
 * email verification live in merchant-signup.routes.ts / auth.routes.ts.
 */
const router = Router();
router.param('storeId', tenantContext);

const merchantOnly = [authenticate, authorize('store_admin', 'super_admin')];

// GET /onboarding/state - where this merchant is in the funnel (resume point).
router.get('/state', ...merchantOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await OnboardingService.state(req.user!.userId) });
  } catch (error) {
    next(error);
  }
});

// A16: a merchant who hits a protected brand address, or the daily store-creation cap, asks Ebda staff with evidence.
// Filed before a store exists, so the row is keyed on the user (withUser). Staff decide: a super admin lifts the
// protected list (`allowProtected`) or the cap through the existing super-admin paths.
const evidenceUrl = z
  .string()
  .trim()
  .max(500)
  .refine(u => u.startsWith('https://'), 'Evidence link must be https')
  .optional();
const slugClaimBody = z.object({
  slug: z.string().trim().min(1).max(60),
  evidence: z.string().trim().min(10).max(1000),
  evidenceUrl,
});
const storeCapBody = z.object({ message: z.string().trim().min(10).max(1000), evidenceUrl });
const asTrustDb = (tx: unknown) => tx as TrustDb;

router.post(
  '/slug-claims',
  ...merchantOnly,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthUser(req);
      const input = parseInput(slugClaimBody, req.body);
      const row = await withUser(user.userId, tx =>
        fileSlugClaim(asTrustDb(tx), { userId: user.userId, email: user.email }, input)
      );
      await auditLog({
        action: 'onboarding.slug_claim',
        userId: user.userId,
        resourceType: 'trust_request',
        resourceId: row.id,
        details: { slug: input.slug.toLowerCase() },
      });
      void deferAfterTenantCommit('onboarding-request.notify', () =>
        notifyStaff({
          subject: `Protected address claim: ${input.slug.toLowerCase()}`,
          lines: [
            `Address: ${input.slug.toLowerCase()}`,
            user.email ? `From: ${user.email}` : '',
            input.evidenceUrl ? `Evidence: ${input.evidenceUrl}` : '',
            '',
            input.evidence,
          ].filter(l => l !== ''),
          replyTo: user.email,
          ref: { requestId: row.id, kind: 'slug_claim' },
        })
      );
      res.status(201).json({ success: true, data: { id: row.id } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/store-cap-requests',
  ...merchantOnly,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthUser(req);
      const input = parseInput(storeCapBody, req.body);
      const row = await withUser(user.userId, tx =>
        fileStoreCapRequest(asTrustDb(tx), { userId: user.userId, email: user.email }, input)
      );
      await auditLog({
        action: 'onboarding.store_cap_request',
        userId: user.userId,
        resourceType: 'trust_request',
        resourceId: row.id,
      });
      void deferAfterTenantCommit('onboarding-request.notify', () =>
        notifyStaff({
          subject: 'Daily store limit request',
          lines: [
            user.email ? `From: ${user.email}` : '',
            input.evidenceUrl ? `Evidence: ${input.evidenceUrl}` : '',
            '',
            input.message,
          ].filter(l => l !== ''),
          replyTo: user.email,
          ref: { requestId: row.id, kind: 'store_cap' },
        })
      );
      res.status(201).json({ success: true, data: { id: row.id } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /onboarding/slug-check?slug=amelia - live availability for the stepper.
// Authenticated (and rate limited) so it is not an open scraper of taken names.
router.get(
  '/slug-check',
  ...merchantOnly,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = z.object({ slug: z.string().min(1).max(60) }).parse(req.query);
      res.json({
        success: true,
        data: await OnboardingService.checkSlug(slug, {
          allowProtected: req.user!.role === 'super_admin',
        }),
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /onboarding/store - create the (inactive) store on the Growth trial. Verified email only.
router.post(
  '/store',
  ...merchantOnly,
  requireVerifiedEmail,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createStoreSchema.parse(req.body);
      const { store, lookApplied } = await OnboardingService.createStore(
        { userId: req.user!.userId, isSuperAdmin: req.user!.role === 'super_admin' },
        data
      );
      await auditLog({
        action: 'store.self_serve_created',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: store.id,
        details: { slug: store.slug },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res
        .status(201)
        .json({ success: true, data: { store: toSafeStoreResponse(store), lookApplied } });
    } catch (error) {
      next(error);
    }
  }
);

const paymentSchema = z
  .object({
    cod: z.boolean(),
    // Optional so a COD-only client (the original contract) keeps working. When
    // `enabled`, a handle or phone is required (validated by the shared InstaPay schema).
    instapay: z
      .object({
        enabled: z.boolean(),
        handle: z.string().trim().max(120).optional(),
        phone: z.string().trim().max(32).optional(),
        accountName: z.string().trim().max(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// PUT /onboarding/stores/:storeId/payment-methods - COD and InstaPay on/off (card gateways are
// set up later in Settings > Payments).
router.put(
  '/stores/:storeId/payment-methods',
  ...merchantOnly,
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cod, instapay } = paymentSchema.parse(req.body);
      // InstaPay first: `setPaymentMethods` then sees the new state when it enforces
      // "at least one method stays on". An error rolls the whole request transaction back.
      const instapayResult = instapay
        ? await applyOnboardingInstapay(req.params.storeId, instapay)
        : undefined;
      const data = await OnboardingService.setPaymentMethods(req.params.storeId, { cod });
      if (instapayResult?.configId) {
        await auditLog({
          action: 'store_payment_config.updated',
          userId: req.user!.userId,
          resourceType: 'payment_config',
          resourceId: instapayResult.configId,
          details: { storeId: req.params.storeId, provider: 'instapay', via: 'onboarding' },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }
      res.json({
        success: true,
        data: instapayResult ? { ...data, instapay: instapayResult.instapay } : data,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /onboarding/stores/:storeId/go-live - inactive -> active.
router.post(
  '/stores/:storeId/go-live',
  ...merchantOnly,
  requireStoreAccess,
  requireVerifiedEmail,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = await OnboardingService.goLive(req.params.storeId);
      await auditLog({
        action: 'store.went_live',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: store.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { store: toSafeStoreResponse(store) } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
