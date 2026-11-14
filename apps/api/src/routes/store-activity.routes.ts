/**
 * GET /stores/:storeId/activity - the merchant's own activity log (self-service gap A24, capability team.audit-log).
 *
 * Read-only view of the store's `audit_logs` rows: who did what, when. The STORE OWNER only (role store_admin AND
 * `store.ownerId === caller`, checked again here after `requireStoreAccess`); staff carry role 'staff' (the identity profile
 * decides, see accountsUser) and are refused by `authorize`; a store_admin of another store is refused 403 by
 * `requireStoreAccess` (404 when the store does not exist). A super admin keeps the override (platform support may read any
 * store's log) and every such read leaves an audit row (STORE_ACTIVITY_VIEWED). Newest first, cursor pagination on (createdAt, id), explicit select. Output never carries
 * the raw IP (network prefix only), the user agent, or an actor e-mail; `details` is flattened to short scalars with
 * sensitive keys dropped and contact fields masked. No audit row is written for a read of one's own log.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import { storeDb } from '../lib/repo-factory';
import { getAccountsBrief } from '../lib/identity-client';
import { maskEmail, maskIp, maskPhone, scrubEmails } from '../lib/pii-mask';

const router = Router({ mergeParams: true });

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().max(200).optional(),
});

/**
 * Ruling ACT-3 - deny-list, not a per-action allow-list: audit actions number in the hundreds across routes and a list per action
 * would rot. Secrets are dropped by key (word-anchored families, so `couponCode` / `postcode` / `sku` survive), every string
 * value is scrubbed of emails AND phone-like digit runs, nested values are not shown. Cost if wrong: an unusual secret key name
 * would be shown to the store owner, who is the store's own admin.
 */
const DROP_KEY =
  /^key$|token|secret|passw(or)?d|hash|authorization|cookie|bearer|jwt|signature|otp|iban|cvv|cvc|pin$|ssn|national.?id|(verification|reset|backup|recovery|auth|access|promo)?(api|secret|private|signing|encryption|access)key|(verification|reset|backup|recovery|otp)code|card.?(number|no|num)|address|user.?agent/i;
const EMAIL_KEY = /e-?mail/i;
const PHONE_KEY = /phone|mobile|whatsapp|tel$/i;
const MAX_DETAIL_KEYS = 8;
const MAX_DETAIL_CHARS = 120;

/** Phone-like runs (7+ digits, with optional + / spaces / dashes / brackets) inside free text. */
const PHONE_RUN = /\+?\d[\d\s().-]{5,}\d/g;
const scrubText = (v: string): string =>
  scrubEmails(v.slice(0, MAX_DETAIL_CHARS)).replace(PHONE_RUN, m => maskPhone(m) ?? '****');

function cleanDetails(raw: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_DETAIL_KEYS) break;
    if (DROP_KEY.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (typeof v === 'string') {
      if (EMAIL_KEY.test(k)) out[k] = maskEmail(v);
      else if (PHONE_KEY.test(k)) out[k] = maskPhone(v);
      else out[k] = scrubText(v);
    }
    // nested objects / arrays are not shown: they are where free text and contact blocks hide
  }
  return out;
}

function decodeCursor(raw: string): { at: Date; id: string } {
  try {
    const [ms, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    const at = new Date(Number(ms));
    if (!id || Number.isNaN(at.getTime())) throw new Error('bad');
    return { at, id };
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid cursor');
  }
}

router.get(
  '/',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query');
      const { limit, cursor } = parsed.data;
      const { storeId } = req.params;
      const caller = req.user!;
      // Defence in depth: requireStoreAccess already admits a store_admin only for an owned store; the owner is checked again
      // on the store row it attached, so a future change to that middleware cannot silently widen this screen.
      if (caller.role !== 'super_admin' && req.store?.ownerId !== caller.userId)
        throw new AppError(403, 'FORBIDDEN', 'Only the store owner can read the activity log');
      if (caller.role === 'super_admin') {
        await auditLog({
          action: 'STORE_ACTIVITY_VIEWED',
          userId: caller.userId,
          storeId,
          resourceType: 'store',
          resourceId: storeId,
          details: { via: 'super_admin_access' },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }
      const c = cursor ? decodeCursor(cursor) : null;

      const db = await storeDb(storeId);
      const rows = await db.auditLog.findMany({
        where: {
          storeId, // from the path-checked store, never the body
          ...(c
            ? {
                AND: [
                  {
                    OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }],
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          action: true,
          userId: true,
          resourceType: true,
          resourceId: true,
          details: true,
          ipAddress: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? Buffer.from(`${last.createdAt.getTime()}|${last.id}`).toString('base64url')
          : null;

      const ids = [...new Set(page.map(r => r.userId).filter((x): x is string => !!x))];
      // The identity service being down must not hide the log (most needed during an incident): names degrade to null.
      const briefs = new Map(
        (await (ids.length ? getAccountsBrief(ids) : Promise.resolve([])).catch(() => [])).map(
          b => [b.id, b]
        )
      );

      res.json({
        success: true,
        data: {
          items: page.map(r => {
            const b = r.userId ? briefs.get(r.userId) : undefined;
            return {
              id: r.id,
              at: r.createdAt.toISOString(),
              action: r.action,
              resourceType: r.resourceType,
              resourceId: r.resourceId,
              actor: b
                ? { name: `${b.firstName ?? ''} ${b.lastName ?? ''}`.trim(), role: b.role }
                : null,
              ip: maskIp(r.ipAddress),
              details: cleanDetails(r.details),
            };
          }),
          nextCursor,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
