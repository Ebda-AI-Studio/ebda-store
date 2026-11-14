/**
 * GET /stores/:storeId/activity - the merchant's own activity log (self-service gap A24, capability team.audit-log).
 *
 * Read-only view of the store's `audit_logs` rows: who did what, when. Owner / store_admin only (staff are refused);
 * `requireStoreAccess` answers 404 for a store that is not the caller's, and a super admin keeps the override (platform support
 * may read any store's log). Newest first, cursor pagination on (createdAt, id), explicit select. Output never carries
 * the raw IP (network prefix only), the user agent, or an actor e-mail; `details` is flattened to short scalars with
 * sensitive keys dropped and contact fields masked. No audit row is written for a read of one's own log.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { AppError } from '../middleware/error-handler';
import { storeDb } from '../lib/repo-factory';
import { getAccountsBrief } from '../lib/identity-client';
import { maskEmail, maskIp, maskPhone, scrubEmails } from '../lib/pii-mask';

const router = Router({ mergeParams: true });

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().max(200).optional(),
  action: z
    .string()
    .trim()
    .regex(/^[a-z0-9_.:-]{1,80}$/i)
    .optional(),
});

const DROP_KEY =
  /token|secret|password|passwd|key|hash|code|authorization|cookie|card|iban|otp|address|userAgent/i;
const EMAIL_KEY = /e-?mail/i;
const PHONE_KEY = /phone|mobile|whatsapp|tel$/i;
const MAX_DETAIL_KEYS = 8;
const MAX_DETAIL_CHARS = 120;

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
      else out[k] = scrubEmails(v.slice(0, MAX_DETAIL_CHARS));
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
      const { limit, cursor, action } = parsed.data;
      const { storeId } = req.params;
      const c = cursor ? decodeCursor(cursor) : null;

      const db = await storeDb(storeId);
      const rows = await db.auditLog.findMany({
        where: {
          storeId, // from the path-checked store, never the body
          ...(action ? { action } : {}),
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
      const briefs = new Map((ids.length ? await getAccountsBrief(ids) : []).map(b => [b.id, b]));

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
