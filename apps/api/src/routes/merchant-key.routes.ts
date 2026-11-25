/**
 * Merchant-admin MCP keys — issue, list and revoke.
 *
 * The merchant-admin MCP surface (`POST /api/v1/mcp/admin/:storeSlug`) refuses
 * every request without a valid `x-merchant-key`. This is the surface that
 * issues those keys; without it the credential requirement would brick the
 * feature rather than secure it.
 *
 * Routes (same auth chain and mount shape as `agent-credential.routes.ts`):
 *   GET    /stores/:id/integrations/merchant-keys      — list, metadata only
 *   POST   /stores/:id/integrations/merchant-keys      — mint; plaintext ONCE
 *   DELETE /stores/:id/integrations/merchant-keys/:keyId — revoke
 *
 * ## Why this is a collection, not a single key like the agent credential
 *
 * `Store.agentApiKey` is one value per store because it has one holder — the
 * shopping-agent integration. A merchant-admin key is a DEVICE credential:
 * one per laptop, per CI job, per teammate. Revoking the key on a lost laptop
 * must not sign out the merchant's other machines, and every audit row must
 * name which human acted. That is why `MerchantApiKey` carries `userId` and
 * why revoke takes a key id.
 *
 * ## Why the plaintext is unrecoverable
 *
 * Stored as a SHA-256 hash, not encrypted. The agent key is encrypted because
 * the admin UI shows it again; this one is shown exactly once, at creation. A
 * lost key is rotated, never recovered — so no read path anywhere can leak it,
 * which is also the concern Ruling M5 raised about credential ciphertext
 * riding out on wide `Store` reads.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import { readInStoreContext, runInStoreTenantContext } from '../lib/store-scoped-read';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireMfaEnrolled, requireRecentLogin } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { auditLog } from '../middleware/security';
import { getAccountsBrief } from '../lib/identity-client';
import { onAccessD1 } from '../services/platform/access-d1';
import { StoreService } from '../services/store.service';
import { getAuthUser } from '../utils/store-helpers';
import {
  generateMerchantKey,
  ALL_MERCHANT_SCOPES,
  MERCHANT_KEY_HEADER,
  MERCHANT_SCOPES,
  type MerchantScope,
} from '../mcp/merchant-auth';

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  userId?: string;
  user?: { id: string; email: string; firstName: string; lastName: string } | null;
}

const router = Router({ mergeParams: true });

const chain = [
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('merchant_mcp'),
] as const;

/**
 * Cap per store. Not a security boundary — it is a housekeeping bound so an
 * automated mint loop cannot grow the table without limit, and so a merchant
 * looking at the list can still recognise their own devices.
 */
const MAX_ACTIVE_KEYS = 20;

const mintSchema = z.object({
  name: z.string().min(1).max(64),
  /**
   * Defaults to READ ONLY. A key minted without an explicit scope list must be
   * the least dangerous thing it could be — defaulting to full access would
   * make the scope system decorative for everyone who does not read the docs.
   */
  scopes: z
    .array(z.enum([MERCHANT_SCOPES.read, MERCHANT_SCOPES.write, MERCHANT_SCOPES.destructive]))
    .min(1)
    .optional(),
  /** Days until expiry. Omitted = no expiry. */
  expiresInDays: z.number().int().min(1).max(730).optional(),
});

// ─── GET /stores/:id/integrations/merchant-keys ──────────────────────────────

router.get(
  '/:id/integrations/merchant-keys',
  ...chain,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId } = req.params;
      // `keyHash` is NEVER selected. It is not the plaintext, but it is the
      // exact value `verifyMerchantKey` looks a request up by, so handing it
      // out would let anyone who can read this list authenticate as the key.
      // `runInTenantContext`: this router is mounted under
      // `router.use('/stores', tenantContext, ...)`, but `tenantContext` reads
      // `req.params.storeId || req.params.id` at MOUNT level where `req.params`
      // is empty — so it calls next() and these queries would run with no
      // store GUC. Opening the scope here explicitly is what makes the table's
      // RLS policy actually bind, rather than relying on its
      // `current_store_id() IS NULL` escape clause.
      // After the `access` cutover the owning accounts live in the identity service, so the `user` relation cannot be joined
      // (prisma-lite: it lives in another database): read the keys, then the owners' display facts in ONE identity call.
      const accountsInIdentity = await onAccessD1();
      const rawKeys = (await readInStoreContext(storeId, () =>
        prisma.merchantApiKey.findMany({
          where: { storeId },
          select: {
            id: true,
            name: true,
            prefix: true,
            scopes: true,
            lastUsedAt: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
            ...(accountsInIdentity
              ? { userId: true }
              : { user: { select: { id: true, email: true, firstName: true, lastName: true } } }),
          },
          orderBy: { createdAt: 'desc' },
        })
      )) as unknown as KeyRow[];
      const briefs = accountsInIdentity
        ? new Map(
            (await getAccountsBrief(rawKeys.map(k => k.userId as string))).map(a => [a.id, a])
          )
        : null;
      const keys = rawKeys.map(({ userId, ...k }) => {
        if (!briefs) return k;
        const a = briefs.get(userId as string);
        return {
          ...k,
          user: a
            ? { id: a.id, email: a.email, firstName: a.firstName, lastName: a.lastName }
            : null,
        };
      });

      // The SLUG, not just the id: the MCP endpoint is addressed by slug, and
      // the admin's one-time reveal has to render a copy-pasteable client
      // config. Deriving it in the browser is what produced a wrong host.
      const store = await readInStoreContext(storeId, () => StoreService.getById(storeId));

      res.json({
        success: true,
        data: {
          header: MERCHANT_KEY_HEADER,
          storeSlug: store?.slug ?? null,
          availableScopes: ALL_MERCHANT_SCOPES,
          keys: keys.map(k => ({
            ...k,
            active: k.revokedAt === null && (k.expiresAt === null || k.expiresAt > new Date()),
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /stores/:id/integrations/merchant-keys ─────────────────────────────

router.post(
  '/:id/integrations/merchant-keys',
  ...chain,
  // BE:S-2 (Ruling FP-3): an impersonated session must not mint a durable key that outlives it.
  rejectImpersonated,
  requireRecentLogin, // TEN-4: credential-class change needs a recent sign-in
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId } = req.params;
      const body = mintSchema.parse(req.body);
      const actor = getAuthUser(req);

      const activeCount = await readInStoreContext(storeId, () =>
        prisma.merchantApiKey.count({ where: { storeId, revokedAt: null } })
      );
      if (activeCount >= MAX_ACTIVE_KEYS) {
        res.status(409).json({
          success: false,
          error: {
            code: 'TOO_MANY_KEYS',
            message: `This store already has ${MAX_ACTIVE_KEYS} active merchant keys. Revoke one before issuing another.`,
          },
        });
        return;
      }

      const scopes: MerchantScope[] = body.scopes ?? [MERCHANT_SCOPES.read];
      const { plaintext, hash, prefix } = generateMerchantKey();

      const created = await runInStoreTenantContext(storeId, () =>
        prisma.merchantApiKey.create({
          data: {
            storeId,
            // The key acts as the human who minted it. A key is a device, not an
            // identity — so every tool call it makes is attributable to a person.
            userId: actor.userId,
            name: body.name,
            keyHash: hash,
            prefix,
            scopes,
            expiresAt: body.expiresInDays
              ? new Date(Date.now() + body.expiresInDays * 86_400_000)
              : null,
          },
          select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true },
        })
      );

      await auditLog({
        action: 'store.merchant_key_issued',
        userId: actor.userId,
        resourceType: 'merchant_api_key',
        resourceId: created.id,
        storeId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        // The plaintext and the hash are both absent on purpose: an audit log
        // is read by more people than a credential store should be.
        details: { name: body.name, scopes, expiresAt: created.expiresAt },
      });

      res.status(201).json({
        success: true,
        data: {
          ...created,
          // The ONLY time the plaintext leaves the server. There is no
          // "show it again" — a lost key is revoked and re-minted.
          apiKey: plaintext,
          header: MERCHANT_KEY_HEADER,
          warning: 'Copy this key now. It cannot be shown again.',
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET/PUT /stores/:id/integrations/merchant-mcp/write-switch ──────────────
//
// The merchant's per-store on/off switch for MCP WRITE tools. Stored in the
// existing `store.settings` JSON (`mcpWriteEnabled`, absent = on), so no
// migration. The plan half (Growth + Business) is the `merchant_mcp_write`
// feature; a write needs BOTH (mcp/merchant-write.ts).

const writeSwitchSchema = z.object({ enabled: z.boolean() });

router.get(
  '/:id/integrations/merchant-mcp/write-switch',
  ...chain,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId } = req.params;
      const store = await StoreService.getById(storeId);
      const settings = (store.settings as Record<string, unknown> | null) ?? {};
      res.json({ success: true, data: { enabled: settings.mcpWriteEnabled !== false } });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/:id/integrations/merchant-mcp/write-switch',
  ...chain,
  rejectImpersonated, // TEN-3 sweep
  requireRecentLogin, // TEN-4: credential-class change needs a recent sign-in
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId } = req.params;
      const { enabled } = writeSwitchSchema.parse(req.body);
      await StoreService.setMcpWriteEnabled(storeId, enabled);
      await auditLog({
        action: 'store.merchant_mcp_write_switch',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        storeId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        details: { enabled },
      });
      res.json({ success: true, data: { enabled } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /stores/:id/integrations/merchant-keys/:keyId ────────────────────

router.delete(
  '/:id/integrations/merchant-keys/:keyId',
  ...chain,
  rejectImpersonated, // TEN-3 sweep
  requireRecentLogin, // TEN-4: credential-class change needs a recent sign-in
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId, keyId } = req.params;

      // Scoped by storeId as well as id: `requireStoreAccess` proves the caller
      // may act on THIS store, and without the storeId term a caller with
      // access to store A could revoke store B's key by guessing its uuid.
      const result = await runInStoreTenantContext(storeId, () =>
        prisma.merchantApiKey.updateMany({
          where: { id: keyId, storeId, revokedAt: null },
          data: { revokedAt: new Date() },
        })
      );

      if (result.count === 0) {
        // Same body whether the key does not exist, belongs to another store,
        // or is already revoked — no enumeration oracle over key ids.
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
        return;
      }

      await auditLog({
        action: 'store.merchant_key_revoked',
        userId: getAuthUser(req).userId,
        resourceType: 'merchant_api_key',
        resourceId: keyId,
        storeId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.json({ success: true, data: { revoked: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
