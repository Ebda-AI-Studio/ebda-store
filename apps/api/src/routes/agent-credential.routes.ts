/**
 * Agent (MCP) write credential — merchant admin API.
 *
 * The MCP write tools (`add_to_cart`, `place_order`) require the store's own
 * agent credential in the `x-agent-key` header (Ruling M1). This is the surface
 * that issues, rotates and revokes it — without it the credential requirement
 * would have no way to be satisfied and the feature would be bricked rather
 * than secured.
 *
 * Routes:
 *   GET    /stores/:id/integrations/agent-key  — status only (never the key):
 *                                                whether one exists, when it was
 *                                                last rotated, and whether the
 *                                                `agent_checkout_open_writes`
 *                                                escape hatch is on for this store
 *   POST   /stores/:id/integrations/agent-key  — mint or rotate; returns the
 *                                                plaintext key EXACTLY ONCE
 *   DELETE /stores/:id/integrations/agent-key  — revoke (writes are refused
 *                                                again from the next call)
 *
 * The key is stored AES-256-GCM-encrypted in `Store.agentApiKey` via the shared
 * `encryption.service`. It is never logged, never
 * returned by GET, and never used as a cache or rate-limit key.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { prisma } from '@ebda/database';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireMfaEnrolled, requireRecentLogin } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { encryption } from '../services/encryption.service';
import { featureService } from '../services/feature.service';
import { AGENT_OPEN_WRITES_FEATURE } from '../mcp/agent-auth';
import { auditLog } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { storeDb, storeUpdate, storeWriter, storeWritesToDo } from '../lib/repo-factory';

/**
 * The agent key of a store. A store on its Durable Object keeps it in the DO's `store_credentials` row (Ruling NZ-AGENT-KEY-1):
 * read through `storeDb`, written through `storeWriter` (ciphertext only); the row's `updatedAt` is the rotation time, because
 * `Store.agentApiKeyRotatedAt` is not a DO column. A Postgres store keeps its relation write exactly as before.
 */
async function readCredential(storeId: string) {
  if (await storeWritesToDo(storeId)) {
    const row = await (
      await storeDb(storeId)
    ).storeCredential.findUnique({
      where: { storeId },
      select: { agentApiKey: true, updatedAt: true },
    });
    return {
      exists: true,
      agentApiKey: row?.agentApiKey ?? null,
      rotatedAt: row?.updatedAt ?? null,
    };
  }
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { credentials: { select: { agentApiKey: true } }, agentApiKeyRotatedAt: true },
  });
  return {
    exists: Boolean(store),
    agentApiKey: store?.credentials?.agentApiKey ?? null,
    rotatedAt: store?.agentApiKeyRotatedAt ?? null,
  };
}

/** `ciphertext` null = revoke. */
async function writeCredential(storeId: string, ciphertext: string | null): Promise<void> {
  if (await storeWritesToDo(storeId)) {
    const now = new Date();
    await (
      await storeWriter(storeId)
    ).storeCredential.upsert({
      where: { storeId },
      create: { storeId, agentApiKey: ciphertext, createdAt: now, updatedAt: now },
      update: { agentApiKey: ciphertext, updatedAt: now },
    });
    return;
  }
  await storeUpdate(prisma, {
    where: { id: storeId },
    data: {
      agentApiKeyRotatedAt: new Date(),
      credentials: {
        upsert: { create: { agentApiKey: ciphertext }, update: { agentApiKey: ciphertext } },
      },
    },
  });
}

const router = Router({ mergeParams: true });

const KEY_PREFIX = 'fak_'; // "force agent key" — greppable in a merchant's config

/** 32 random bytes, base64url. ~256 bits; not derived from anything guessable. */
function mintKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

const chain = [
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('agent_checkout'),
] as const;

// ─── GET /stores/:id/integrations/agent-key ──────────────────────────────────

router.get(
  '/:id/integrations/agent-key',
  ...chain,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId } = req.params;
      const store = await readCredential(storeId);
      if (!store.exists) {
        res.status(404).json({ success: false, error: { code: 'STORE_NOT_FOUND' } });
        return;
      }
      // The escape hatch (Ruling M2) is resolved SERVER-SIDE and returned here
      // rather than read in the browser from `useFeatures()`. That hook returns
      // `true` for EVERY key while the feature map is still loading (a
      // deliberate anti-flicker default), so an admin screen that asked it
      // would state "writes are open without a key" for the first paint of
      // every store — a fail-OPEN reading of a security control. This value is
      // never optimistic.
      const openWrites = await featureService
        .isFeatureEnabled(storeId, AGENT_OPEN_WRITES_FEATURE)
        .catch(() => false);

      // Status only. There is no "show me the key again" — a lost key is
      // rotated, not recovered, so a leaked read of this endpoint is worthless.
      res.json({
        success: true,
        data: {
          hasKey: Boolean(store.agentApiKey),
          rotatedAt: store.rotatedAt,
          header: 'x-agent-key',
          openWrites,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /stores/:id/integrations/agent-key ─────────────────────────────────

router.post(
  '/:id/integrations/agent-key',
  ...chain,
  rejectImpersonated, // BE:S-2 (Ruling FP-3)
  requireRecentLogin, // TEN-4: credential-class change needs a recent sign-in
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId } = req.params;
      const store = await readCredential(storeId);
      if (!store.exists) {
        res.status(404).json({ success: false, error: { code: 'STORE_NOT_FOUND' } });
        return;
      }

      const key = mintKey();
      await writeCredential(storeId, encryption.encrypt(key));

      await auditLog({
        action: 'store.agent_key_issued',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        storeId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        details: { rotated: Boolean(store.agentApiKey) },
      });

      // The ONLY time the plaintext leaves the server. Rotating invalidates the
      // previous key immediately — there is no overlap window, which is the
      // right default for a credential with one holder.
      res.status(201).json({
        success: true,
        data: {
          apiKey: key,
          header: 'x-agent-key',
          rotated: Boolean(store.agentApiKey),
          message:
            'Store this key now — it is shown once and cannot be retrieved again. ' +
            'Rotating issues a new key and immediately invalidates this one.',
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /stores/:id/integrations/agent-key ───────────────────────────────

router.delete(
  '/:id/integrations/agent-key',
  ...chain,
  rejectImpersonated, // BE:S-2 (Ruling FP-3)
  requireRecentLogin, // TEN-4: credential-class change needs a recent sign-in
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: storeId } = req.params;
      const store = await readCredential(storeId);
      if (!store.exists) {
        res.status(404).json({ success: false, error: { code: 'STORE_NOT_FOUND' } });
        return;
      }

      await writeCredential(storeId, null);

      await auditLog({
        action: 'store.agent_key_revoked',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        storeId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        details: { hadKey: Boolean(store.agentApiKey) },
      });

      res.json({ success: true, data: { hasKey: false } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
