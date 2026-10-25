/**
 * `POST /public/cart/whatsapp-optin` (Ruling WA-CONSENT-1, security reviews). Built from injected
 * dependencies so the real middleware order is testable with real rate limiters.
 *
 * Order matters: AUTH FIRST, then 401 for anyone anonymous BEFORE any limiter runs, so an anonymous
 * flood consumes nothing and can never block a signed-in buyer's withdrawal. Then a per-USER limiter
 * (grants and revocations), then the store-wide ceiling for GRANTS only: a revocation never meets a
 * shared limiter, so withdrawal always succeeds.
 *
 * The body carries no phone. The caller must be a signed-in customer with a cart in THIS session; the
 * number is the one on their account and must be proven theirs (an order they placed) to GRANT.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

const bodySchema = z
  .object({ consent: z.boolean(), language: z.enum(['en', 'ar']).optional() })
  .strict();

export interface WhatsAppOptInDeps {
  authenticate: RequestHandler;
  userLimiter: RequestHandler;
  storeLimiter: RequestHandler;
  storeIdFor: (req: Request) => Promise<string>;
  isLinked: (storeId: string) => Promise<boolean>;
  record: (
    storeId: string,
    sessionId: string,
    userId: string,
    input: { consent: boolean; locale?: 'en' | 'ar' }
  ) => Promise<
    | { status: 'recorded'; granted: boolean; cartId: string }
    | { status: 'no_cart' | 'no_phone' | 'phone_unproven' }
  >;
  state: (storeId: string, userId: string) => Promise<{ granted: boolean; proven: boolean }>;
  audit: (entry: {
    action: string;
    resourceType: string;
    resourceId: string;
    storeId: string;
    userId: string;
    details: Record<string, unknown>;
  }) => Promise<unknown>;
}

const ERROR = {
  no_cart: { http: 404, code: 'NO_CART' },
  no_phone: { http: 400, code: 'NO_PHONE' },
  phone_unproven: { http: 400, code: 'PHONE_UNPROVEN' },
} as const;

export function createWhatsAppOptInHandlers(deps: WhatsAppOptInDeps): RequestHandler[] {
  const requireSignedIn: RequestHandler = (req, res, next) => {
    if (!req.user?.userId) {
      res.status(401).json({
        success: false,
        error: { code: 'LOGIN_REQUIRED', message: 'Sign in to manage WhatsApp offers' },
      });
      return;
    }
    next();
  };
  // Resolve the store BEFORE the store-wide limiter so it is keyed on the resolved id, never on a raw
  // client-controlled header.
  const resolveStore: RequestHandler = async (req, res, next) => {
    try {
      res.locals.waStoreId = await deps.storeIdFor(req);
      next();
    } catch (err) {
      next(err);
    }
  };
  const grantsOnly: RequestHandler = (req, res, next) =>
    req.body?.consent === true ? deps.storeLimiter(req, res, next) : next();

  const handler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.headers['x-session-id'] as string;
      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_SESSION', message: 'Session ID required' },
        });
        return;
      }
      const userId = req.user!.userId;
      const body = bodySchema.parse(req.body);
      const storeId = res.locals.waStoreId as string;
      if (body.consent && !(await deps.isLinked(storeId))) {
        res.status(404).json({
          success: false,
          error: { code: 'WHATSAPP_NOT_AVAILABLE', message: 'Not available' },
        });
        return;
      }
      const result = await deps.record(storeId, sessionId, userId, {
        consent: body.consent,
        locale: body.language,
      });
      if (result.status !== 'recorded') {
        const e = ERROR[result.status];
        res
          .status(e.http)
          .json({ success: false, error: { code: e.code, message: 'Not recorded' } });
        return;
      }
      await deps.audit({
        action: body.consent
          ? 'whatsapp.marketing_consent_granted'
          : 'whatsapp.marketing_consent_revoked',
        resourceType: 'cart',
        resourceId: result.cartId,
        storeId,
        userId,
        details: { source: 'checkout', cartId: result.cartId, locale: body.language ?? null },
      });
      res.json({ success: true, data: { granted: result.granted } });
    } catch (error) {
      next(error);
    }
  };
  return [deps.authenticate, requireSignedIn, deps.userLimiter, resolveStore, grantsOnly, handler];
}

/** `GET`: the signed-in customer's current consent, for the checkout box. */
export function createWhatsAppOptInStateHandlers(deps: WhatsAppOptInDeps): RequestHandler[] {
  const requireSignedIn: RequestHandler = (req, res, next) => {
    if (!req.user?.userId) {
      res
        .status(401)
        .json({ success: false, error: { code: 'LOGIN_REQUIRED', message: 'Sign in' } });
      return;
    }
    next();
  };
  const handler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = await deps.storeIdFor(req);
      res.json({ success: true, data: await deps.state(storeId, req.user!.userId) });
    } catch (error) {
      next(error);
    }
  };
  return [deps.authenticate, requireSignedIn, deps.userLimiter, handler];
}
