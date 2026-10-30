import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import { storeRwClient } from '../lib/jobs/store-db';
import {
  DEFAULT_PLAN_SEEDS,
  PLAN_LIMIT_ERROR_CODE,
  WEBHOOK_LOG_KEEP_PER_ENDPOINT,
  WEBHOOK_MAX_ENDPOINTS_PER_STORE,
  planIncludesWebhooks,
  webhookEndpointCreateSchema,
  webhookEndpointUpdateSchema,
} from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import { sendEventAfterCommit } from '../lib/inngest/send-after-commit';
import { assertWebhookUrl } from '../lib/webhook-http';
import { encryption } from '../services/encryption.service';
import { getEntitlements } from '../services/plan-entitlements';
import { createResend, createTestDelivery, newWebhookSecret } from '../services/webhook.service';

/**
 * Merchant outgoing webhooks - admin API. Mounted at `/stores/:storeId/webhooks` with
 * `tenantContext` (routes/index.ts). Plan: docs/plans/2026-10-21-merchant-webhooks.md.
 *
 * Every route: authenticate -> authorize(store_admin, super_admin) -> requireStoreAccess (the
 * store's OWNER; staff are refused: they hold no store:settings) -> plan gate (Growth + Business,
 * Ruling WH-1). The signing secret is returned ONCE, by create and rotate; nothing else ever
 * returns it.
 */
const router = Router({ mergeParams: true });

async function requireWebhooksPlan(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.user?.role === 'super_admin') return next();
    const e = await getEntitlements(req.params.storeId);
    if (e && planIncludesWebhooks(e.planCode)) return next();
    const growth = DEFAULT_PLAN_SEEDS.find(p => p.code === 'growth');
    const messageEn = 'Webhooks are included in the Growth and Business plans.';
    const messageAr = 'الويب هوك متاح في باقتي النمو والأعمال.';
    throw new AppError(402, PLAN_LIMIT_ERROR_CODE, messageEn, {
      limitKey: 'webhooks',
      limit: false,
      planCode: e?.planCode ?? null,
      upgradeTo: growth
        ? { code: growth.code, nameEn: growth.nameEn, nameAr: growth.nameAr }
        : { code: 'growth', nameEn: 'Growth', nameAr: 'النمو' },
      messageEn,
      messageAr,
    });
  } catch (err) {
    next(err);
  }
}

router.use(authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess);

/**
 * A lapsed plan keeps READ + KILL (list, log, disable, delete) so a merchant who dropped below
 * Growth can see and switch off what still holds their data; everything that creates or extends
 * sending (create, test, resend, rotate, re-enable, any other edit) is 402 (review I3).
 */
const isDisableOnly = (b: unknown) =>
  !!b &&
  typeof b === 'object' &&
  Object.keys(b as object).length === 1 &&
  (b as { active?: unknown }).active === false;
const planGateUnlessDisable = (req: Request, res: Response, next: NextFunction) =>
  isDisableOnly(req.body) ? next() : requireWebhooksPlan(req, res, next);

const idParam = z.object({ id: z.string().uuid() });
const deliveryParam = z.object({ id: z.string().uuid(), deliveryId: z.string().uuid() });

/** Never includes secretEnc. */
const ENDPOINT_SELECT = {
  id: true,
  url: true,
  description: true,
  events: true,
  includeCustomer: true,
  secretHint: true,
  active: true,
  disabledReason: true,
  disabledAt: true,
  consecutiveFailures: true,
  lastSuccessAt: true,
  lastFailureAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The store's own backend: the Durable Object for a DO store, Postgres (the request transaction) otherwise. */
const wdb = async (storeId: string) => (await storeRwClient(storeId)).db;

async function endpointOr404(storeId: string, id: string) {
  const ep = await (
    await wdb(storeId)
  ).webhookEndpoint.findFirst({
    where: { id, storeId },
    select: ENDPOINT_SELECT,
  });
  if (!ep) throw new AppError(404, 'NOT_FOUND', 'Webhook endpoint not found');
  return ep;
}

async function checkUrl(url: string) {
  try {
    await assertWebhookUrl(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    throw new AppError(400, 'WEBHOOK_URL_REJECTED', 'This URL cannot be used for webhooks', {
      reason: msg.replace(/^(WEBHOOK_URL|SSRF)_BLOCKED:\s*/, '').slice(0, 80),
    });
  }
}

const audit = (req: Request, action: string, resourceId: string) =>
  auditLog({
    action,
    userId: req.user?.userId,
    storeId: req.params.storeId,
    resourceType: 'webhook_endpoint',
    resourceId,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const endpoints = await (
      await wdb(storeId)
    ).webhookEndpoint.findMany({
      where: { storeId },
      select: ENDPOINT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: WEBHOOK_MAX_ENDPOINTS_PER_STORE,
    });
    res.json({ success: true, data: { endpoints } });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/',
  writeLimiter,
  requireWebhooksPlan,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const input = webhookEndpointCreateSchema.parse(req.body);
      // Serialise concurrent creates of one store: count-then-insert would otherwise let two
      // parallel requests both pass the cap (the lock is released at COMMIT).
      // Postgres only: a store on its Durable Object has one writer, so there is no parallel pair to serialise
      if (!(await storeRwClient(storeId)).onDo)
        await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`webhook-endpoints:${storeId}`}, 0))`;
      const count = await (await wdb(storeId)).webhookEndpoint.count({ where: { storeId } });
      if (count >= WEBHOOK_MAX_ENDPOINTS_PER_STORE) {
        throw new AppError(409, 'WEBHOOK_LIMIT', 'Webhook endpoint limit reached', {
          limit: WEBHOOK_MAX_ENDPOINTS_PER_STORE,
        });
      }
      await checkUrl(input.url);
      const { secret, hint } = newWebhookSecret();
      const endpoint = await (
        await wdb(storeId)
      ).webhookEndpoint.create({
        data: {
          storeId,
          url: input.url,
          description: input.description || null,
          events: input.events,
          includeCustomer: input.includeCustomer,
          secretEnc: encryption.encrypt(secret),
          secretHint: hint,
          createdBy: req.user?.userId ?? null,
        },
        select: ENDPOINT_SELECT,
      });
      await audit(req, 'webhook_endpoint.created', endpoint.id);
      res.status(201).json({ success: true, data: { endpoint, secret } });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  writeLimiter,
  planGateUnlessDisable,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { id } = idParam.parse(req.params);
      const input = webhookEndpointUpdateSchema.parse(req.body);
      const current = await endpointOr404(storeId, id);
      if (input.url !== undefined || input.active === true)
        await checkUrl(input.url ?? current.url);
      // Turning it back on resets the failure streak; turning it off is the merchant's choice.
      const reactivate = input.active === true && !current.active;
      const data = {
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.description !== undefined ? { description: input.description || null } : {}),
        ...(input.events !== undefined ? { events: input.events } : {}),
        ...(input.includeCustomer !== undefined ? { includeCustomer: input.includeCustomer } : {}),
        ...(reactivate
          ? { active: true, disabledReason: null, disabledAt: null, consecutiveFailures: 0 }
          : {}),
        ...(input.active === false && current.active
          ? { active: false, disabledReason: 'merchant', disabledAt: new Date() }
          : {}),
      };
      await (await wdb(storeId)).webhookEndpoint.updateMany({ where: { id, storeId }, data });
      await audit(req, 'webhook_endpoint.updated', id);
      res.json({ success: true, data: { endpoint: await endpointOr404(storeId, id) } });
    } catch (error) {
      next(error);
    }
  }
);

router.delete('/:id', writeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { id } = idParam.parse(req.params);
    await endpointOr404(storeId, id);
    await (await wdb(storeId)).webhookEndpoint.deleteMany({ where: { id, storeId } });
    await audit(req, 'webhook_endpoint.deleted', id);
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/:id/rotate-secret',
  writeLimiter,
  requireWebhooksPlan,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { id } = idParam.parse(req.params);
      await endpointOr404(storeId, id);
      const { secret, hint } = newWebhookSecret();
      await (
        await wdb(storeId)
      ).webhookEndpoint.updateMany({
        where: { id, storeId },
        data: { secretEnc: encryption.encrypt(secret), secretHint: hint },
      });
      await audit(req, 'webhook_endpoint.secret_rotated', id);
      res.json({ success: true, data: { endpoint: await endpointOr404(storeId, id), secret } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/test',
  writeLimiter,
  requireWebhooksPlan,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { id } = idParam.parse(req.params);
      await endpointOr404(storeId, id);
      const deliveryId = await createTestDelivery(storeId, id);
      await sendEventAfterCommit(
        'webhook.test',
        { name: 'webhook/delivery.requested', data: { storeId, deliveryId } },
        { ifUnhookable: 'drop' }
      );
      res.status(202).json({ success: true, data: { deliveryId } });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/:id/deliveries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { id } = idParam.parse(req.params);
    await endpointOr404(storeId, id);
    const deliveries = await (
      await wdb(storeId)
    ).webhookDelivery.findMany({
      where: { storeId, endpointId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: WEBHOOK_LOG_KEEP_PER_ENDPOINT,
      select: {
        id: true,
        eventId: true,
        eventType: true,
        status: true,
        attempts: true,
        isTest: true,
        responseStatus: true,
        responseSnippet: true,
        error: true,
        durationMs: true,
        nextAttemptAt: true,
        deliveredAt: true,
        createdAt: true,
      },
    });
    res.json({ success: true, data: { deliveries } });
  } catch (error) {
    next(error);
  }
});

router.get(
  '/:id/deliveries/:deliveryId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { id, deliveryId } = deliveryParam.parse(req.params);
      const delivery = await (
        await wdb(storeId)
      ).webhookDelivery.findFirst({
        where: { id: deliveryId, endpointId: id, storeId },
        select: { id: true, eventId: true, eventType: true, status: true, payload: true },
      });
      if (!delivery) throw new AppError(404, 'NOT_FOUND', 'Delivery not found');
      res.json({ success: true, data: { delivery } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/deliveries/:deliveryId/resend',
  writeLimiter,
  requireWebhooksPlan,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { id, deliveryId } = deliveryParam.parse(req.params);
      await endpointOr404(storeId, id);
      const owned = await (
        await wdb(storeId)
      ).webhookDelivery.findFirst({
        where: { id: deliveryId, endpointId: id, storeId },
        select: { id: true },
      });
      const newId = owned ? await createResend(storeId, deliveryId) : null;
      if (!newId) throw new AppError(404, 'NOT_FOUND', 'Delivery not found');
      await sendEventAfterCommit(
        'webhook.resend',
        { name: 'webhook/delivery.requested', data: { storeId, deliveryId: newId } },
        { ifUnhookable: 'drop' }
      );
      res.status(202).json({ success: true, data: { deliveryId: newId } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
