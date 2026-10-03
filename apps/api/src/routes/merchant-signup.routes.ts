import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authEmailAddressLimiter, auditLog, merchantSignupIpLimiter } from '../middleware/security';
import {
  GENERIC_SIGNUP_RESULT,
  MerchantSignupService,
  merchantSignupSchema,
} from '../services/merchant-signup.service';

/**
 * Public self-serve merchant signup, mounted at `/auth/merchant`.
 *
 * Both routes are credential-less entry points (no session exists yet) and so
 * sit in the CSRF exempt-auth set (middleware/security.ts). Abuse bounds, in
 * order: a per-IP signup budget, then the address-wide mail budget shared with
 * the other auth mail routes. Email verification itself is the existing
 * `POST /auth/verify-email` (single-use hashed token, 24h expiry).
 */
const router = Router();

router.post(
  '/signup',
  merchantSignupIpLimiter,
  authEmailAddressLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = merchantSignupSchema.parse(req.body);
      const result = await MerchantSignupService.signup(data);
      await auditLog({
        action: 'merchant.signup',
        resourceType: 'user',
        // The submitted address, not a user id: we do not reveal whether a row
        // was created.
        details: { email: data.email },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

const resendSchema = z.object({ email: z.string().trim().email() });

router.post(
  '/resend-verification',
  merchantSignupIpLimiter,
  authEmailAddressLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = resendSchema.safeParse(req.body);
      // A malformed address answers like any other: the generic body is the
      // enumeration defence, so a parse failure must not become a distinct 400.
      if (parsed.success) await MerchantSignupService.resendVerification(parsed.data.email);
      res.status(200).json({ success: true, data: GENERIC_SIGNUP_RESULT });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
