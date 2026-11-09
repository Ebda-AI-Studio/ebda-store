import { Router, Request, Response, NextFunction } from 'express';
import { customerRow, customerRows } from '../lib/customer-directory';
import { z } from 'zod/v3';
import { runInTenantContext, withUser } from '@ebda/database';
import { runInStoreTenantContext } from '../lib/store-scoped-read';
import { authenticate, customerUserId } from '../middleware/auth';
import { publicLimiter, writeLimiter } from '../middleware/security';
import { getStoreIdFromRequest } from '../utils/store-helpers';
import { verifySmsOptOutToken } from '../lib/sms-consent';
import { getSmsConsentById } from '../lib/definer';
import { maskPhone } from '../lib/pii-mask';
import { SmsConsentService } from '../services/sms-consent.service';
import { notificationDispatcher } from '../services/notification-dispatcher.service';
import logger from '../lib/logger';

/**
 * SMS-marketing consent (issue 206).
 *
 * `accountRouter` — mounted at `/auth/me/sms-consent`: the signed-in
 * shopper's own consent for the store in `X-Store-ID`, shown and changed on
 * the storefront account settings page.
 *
 *   GET → { available, phone, consent }
 *   PUT { optIn: boolean } → grant (needs a phone on the profile and a store
 *       that can send promotional SMS) or withdraw (always allowed). CSRF-
 *       checked like any cookie-authenticated write (issue 2425).
 *
 *   `consent` covers the shopper's own row AND every row of the store for
 *   their profile phone — the same rows the send gate and the withdrawal act
 *   on (issue 2423).
 *
 * `publicRouter` — mounted at `/public/sms-consent`: the login-free opt-out
 * link in every promotional SMS (`?t=<signed token>`).
 *
 *   GET  /unsubscribe → validates only (link previews fetch GETs).
 *   POST /unsubscribe → withdraws, phone-wide, for that store.
 */
export const accountRouter = Router();
export const publicRouter = Router();

const putSchema = z.object({ optIn: z.boolean() }).strict();

async function customerContext(req: Request, res: Response) {
  const userId = customerUserId(req);
  if (!userId) {
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Customer account required' },
    });
    return null;
  }
  const storeId = await getStoreIdFromRequest(req);
  const doUser = await customerRow(storeId, userId);
  const user =
    doUser !== undefined
      ? doUser && { phone: doUser.phone, storeId }
      : await withUser(userId, tx =>
          tx.user.findUnique({
            where: { id: userId },
            select: { phone: true, storeId: true },
          })
        );
  // A store-scoped account belongs to one store; a legacy account
  // (storeId NULL) may hold consent in any store it shops at.
  if (!user || (user.storeId && user.storeId !== storeId)) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    return null;
  }
  return { userId, storeId, phone: user.phone ?? null };
}

accountRouter.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = await customerContext(req, res);
    if (!ctx) return;
    const [available, consent] = await Promise.all([
      notificationDispatcher.isSmsMarketingAvailable(ctx.storeId),
      runInStoreTenantContext(
        ctx.storeId,
        () => SmsConsentService.getForCustomerKey(ctx.storeId, ctx.userId, ctx.phone),
        ctx.userId
      ),
    ]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: { available, phone: ctx.phone, consent } });
  } catch (error) {
    next(error);
  }
});

accountRouter.put(
  '/',
  authenticate,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { optIn } = putSchema.parse(req.body);
      const ctx = await customerContext(req, res);
      if (!ctx) return;

      if (optIn) {
        if (!(await notificationDispatcher.isSmsMarketingAvailable(ctx.storeId))) {
          res.status(409).json({
            success: false,
            error: { code: 'SMS_MARKETING_UNAVAILABLE', message: 'SMS offers are not available' },
          });
          return;
        }
        if (!ctx.phone) {
          res.status(409).json({
            success: false,
            error: { code: 'PHONE_REQUIRED', message: 'Add a phone number to your profile first' },
          });
          return;
        }
        const ok = await runInStoreTenantContext(
          ctx.storeId,
          () =>
            SmsConsentService.recordGrant(ctx.storeId, {
              customerKey: ctx.userId,
              userId: ctx.userId,
              phone: ctx.phone!,
              source: 'account',
            }),
          ctx.userId
        );
        if (!ok) {
          res.status(409).json({
            success: false,
            error: {
              code: 'PHONE_REQUIRED',
              message: 'Add a valid phone number to your profile first',
            },
          });
          return;
        }
      } else {
        await runInStoreTenantContext(
          ctx.storeId,
          () =>
            SmsConsentService.revoke(
              ctx.storeId,
              { phone: ctx.phone, userId: ctx.userId },
              'account'
            ),
          ctx.userId
        );
      }

      const consent = await runInStoreTenantContext(
        ctx.storeId,
        () => SmsConsentService.getForCustomerKey(ctx.storeId, ctx.userId, ctx.phone),
        ctx.userId
      );
      logger.info({ storeId: ctx.storeId, optIn }, '[SMS-CONSENT] account change');
      res.json({ success: true, data: { consent } });
    } catch (error) {
      next(error);
    }
  }
);

/** The consent row a token names (the store is on the row, not the token). */
async function consentFromToken(req: Request) {
  const raw = typeof req.query.t === 'string' ? req.query.t : (req.body as { t?: unknown })?.t;
  const consentId = verifySmsOptOutToken(raw);
  if (!consentId) return null;
  // A definer: the token names a consent row and the store is on the row.
  return getSmsConsentById(consentId);
}

publicRouter.get(
  '/unsubscribe',
  publicLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await consentFromToken(req);
      if (!row) {
        res.status(400).json({ success: false, error: { code: 'INVALID_TOKEN' } });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        success: true,
        data: {
          phone: maskPhone(row.phone),
          storeName: row.store?.name ?? null,
          storeNameAr: row.store?.nameAr ?? null,
          alreadyUnsubscribed: !row.granted,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

publicRouter.post(
  '/unsubscribe',
  publicLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await consentFromToken(req);
      if (!row) {
        res.status(400).json({ success: false, error: { code: 'INVALID_TOKEN' } });
        return;
      }
      await runInTenantContext(row.storeId, () =>
        SmsConsentService.revoke(row.storeId, { phone: row.phone }, 'unsubscribe')
      );
      logger.info({ storeId: row.storeId, consentId: row.id }, '[SMS-CONSENT] unsubscribed');
      res.json({ success: true, data: { unsubscribed: true } });
    } catch (error) {
      next(error);
    }
  }
);
