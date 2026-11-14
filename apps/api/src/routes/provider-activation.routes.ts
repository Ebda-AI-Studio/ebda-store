import { auditLog } from '../middleware/security';
import {
  confirmProviderVerification,
  listProviderVerification,
} from '../services/provider-verification.service';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import { asOperator } from '../lib/platform-scope';
import { PAYMENT_PROVIDER_CODES, SHIPPING_PROVIDER_CODES } from '@ebda/shared';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { requireStoreAccess } from '../middleware/store-access';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { storeScopeContext, tenantContext } from '../middleware/tenant-context';
import { providerActivationLimiter } from '../middleware/provider-activation-limiter';
import { idempotencyKeyOf } from '../lib/money-idempotency';
import { AppError } from '../middleware/error-handler';
import { getAuthUser } from '../utils/store-helpers';
import { parseInput } from '../lib/parse-input';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import {
  ACTIVATION_STATUSES,
  activateForStore,
  confirmSelfActivation,
  deactivateForStore,
  previewSelfActivation,
  listAllRequests,
  listStoreRequests,
  notifyOpsOfRequest,
  rejectForStore,
  requestActivation,
  runTestForStore,
  type ActivationActor,
} from '../services/provider-activation.service';

/**
 * Provider activation on request (ruling PROVIDERS-ACTIVATION).
 *
 *  Merchant (mounted at /provider-activation):
 *    GET  /store/:storeId                          this store's requests (latest per provider)
 *    POST /store/:storeId/:provider/request        (dormant since PROVIDERS-3) ask Ebda to activate a provider
 *    POST /store/:storeId/:provider/activate/preview   SELF-SERVICE step 1: the server runs Test connection; a pass returns a confirm token
 *    POST /store/:storeId/:provider/activate/confirm   SELF-SERVICE step 2: token + Idempotency-Key turn the provider on, ledger row, P1
 *
 *  Super admin (`adminProviderActivationRoutes`, mounted at /admin BEFORE admin.routes.ts):
 *    GET  /admin/provider-activation               every store's requests + last test result
 *    POST /admin/provider-activation/:storeId/:provider/test       re-run Test connection
 *    POST /admin/provider-activation/:storeId/:provider/activate   only after a passing test
 *    POST /admin/provider-activation/:storeId/:provider/reject     body { note }
 *    POST /admin/provider-activation/:storeId/:provider/deactivate body { note } turn it off for one store
 *
 * Nothing here returns a credential. The merchant's `activated` is only ever written by `confirmSelfActivation`, after a
 * server-run passing test, a verified single-use confirm token and an Idempotency-Key.
 */
const router = Router();
// The two "Test and turn on" POSTs call the provider with the store's credentials, so they run under store scope
// (no request transaction held across the call); every other route keeps ONE request transaction.
const SELF_ACTIVATION_POST = /\/activate\/(preview|confirm)$/;
router.param('storeId', (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'POST' && SELF_ACTIVATION_POST.test(req.path))
    storeScopeContext(req, res, next);
  else tenantContext(req, res, next);
});

const ALL_CODES = new Set<string>([...PAYMENT_PROVIDER_CODES, ...SHIPPING_PROVIDER_CODES]);
const providerSchema = z.string().refine(c => ALL_CODES.has(c), { message: 'Unknown provider' });
const uuid = z.string().uuid();

function actorOf(req: Request): ActivationActor {
  return {
    userId: getAuthUser(req).userId,
    ip: req.ip,
    userAgent: req.get('user-agent') ?? undefined,
  };
}

router.get(
  '/store/:storeId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requests = await listStoreRequests(req.params.storeId);
      res.json({ success: true, data: { requests } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/store/:storeId/:provider/request',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const provider = parseInput(providerSchema, req.params.provider);
      const actor = actorOf(req);
      const store = await ownedStore(req);
      const { request, created } = await requestActivation(storeId, provider, actor);
      if (created) {
        // After the request transaction committed: the row is durable before anyone is told.
        void deferAfterTenantCommit('provider-activation.notify-ops', async () => {
          await notifyOpsOfRequest({
            storeId,
            storeName: store.name,
            provider,
            requestedAt: request.requestedAt,
            requesterEmail: req.user?.email,
          });
        });
      }
      res.status(created ? 201 : 200).json({ success: true, data: { request, created } });
    } catch (error) {
      next(error);
    }
  }
);

const confirmBodySchema = z.object({ confirmToken: z.string().min(20).max(4000) });

/** Tenant + owner checks shared by both self-service steps (the store id comes from the path, role from auth). */
async function ownedStore(req: Request) {
  const store = await prisma.store.findUnique({
    where: { id: req.params.storeId },
    select: { id: true, name: true, ownerId: true },
  });
  if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  if (getAuthUser(req).role !== 'super_admin' && store.ownerId !== getAuthUser(req).userId) {
    throw new AppError(403, 'FORBIDDEN', 'Access denied');
  }
  return store;
}

const selfService = [
  authenticate,
  requireMfaEnrolled,
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('store:settings'),
];

/** Step 1: the SERVER runs Test connection (the body is ignored), a pass returns a single-use confirm token. */
router.post(
  '/store/:storeId/:provider/activate/preview',
  ...selfService,
  providerActivationLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = parseInput(providerSchema, req.params.provider);
      const store = await ownedStore(req);
      const preview = await previewSelfActivation(store.id, provider, actorOf(req));
      res.json({ success: true, data: preview });
    } catch (error) {
      next(error);
    }
  }
);

/** Step 2: confirm token + Idempotency-Key turn the provider on for checkout (confirm action, ledger, P1). */
router.post(
  '/store/:storeId/:provider/activate/confirm',
  ...selfService,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = parseInput(providerSchema, req.params.provider);
      const { confirmToken } = parseInput(confirmBodySchema, req.body);
      const store = await ownedStore(req);
      const result = await confirmSelfActivation(
        { id: store.id, name: store.name },
        provider,
        { confirmToken, idempotencyKey: idempotencyKeyOf(req.header('idempotency-key')) },
        actorOf(req)
      );
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

// ---------------------------------------------------------------------------
// Super admin
// ---------------------------------------------------------------------------

export const adminProviderActivationRoutes = Router();
const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];
const decisionSchema = z.object({ note: z.string().trim().min(3).max(500) });
const statusSchema = z.object({ status: z.enum(ACTIVATION_STATUSES).optional() });

adminProviderActivationRoutes.get(
  '/provider-activation',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = parseInput(statusSchema, req.query);
      const requests = await asOperator(req.user!.userId, () => listAllRequests(status));
      res.json({ success: true, data: { requests } });
    } catch (error) {
      next(error);
    }
  }
);

/** PROVIDERS-3: per-provider real-traffic evidence and the automatic `verified` flip. */
adminProviderActivationRoutes.get(
  '/provider-verification',
  ...superAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: { providers: await listProviderVerification() } });
    } catch (error) {
      next(error);
    }
  }
);

/** PROVIDERS-3: a super admin confirms a provider that reached "ready" (silences its alerts). */
adminProviderActivationRoutes.post(
  '/provider-verification/:provider/confirm',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = parseInput(providerSchema, req.params.provider);
      const done = await confirmProviderVerification(provider, req.user!.userId);
      await auditLog({
        action: 'provider_verification.confirmed',
        userId: req.user!.userId,
        resourceType: 'provider_verification',
        resourceId: provider,
        details: { provider },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: done });
    } catch (error) {
      next(error);
    }
  }
);

// Super-admin OVERRIDES, kept on purpose (task 12): `activate` (only after the store's own passing test: no force past the
// money gate) and `deactivate` (turn a provider off for one store, with a note the merchant sees).
for (const action of ['test', 'activate', 'reject', 'deactivate'] as const) {
  adminProviderActivationRoutes.post(
    `/provider-activation/:storeId/:provider/${action}`,
    ...superAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const storeId = parseInput(uuid, req.params.storeId);
        const provider = parseInput(providerSchema, req.params.provider);
        const actor = actorOf(req);
        if (action === 'test') {
          const test = await runTestForStore(storeId, provider, actor);
          res.json({ success: true, data: { test } });
        } else if (action === 'activate') {
          const request = await activateForStore(storeId, provider, actor);
          res.json({ success: true, data: { request } });
        } else if (action === 'deactivate') {
          const { note } = parseInput(decisionSchema, req.body);
          res.json({
            success: true,
            data: await deactivateForStore(storeId, provider, note, actor),
          });
        } else {
          const { note } = parseInput(decisionSchema, req.body);
          const request = await rejectForStore(storeId, provider, note, actor);
          res.json({ success: true, data: { request } });
        }
      } catch (error) {
        next(error);
      }
    }
  );
}
