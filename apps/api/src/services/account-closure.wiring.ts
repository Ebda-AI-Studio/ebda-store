import type { Request } from 'express';
import { cfBindings } from '../cf/bindings';
import {
  ciSurface,
  identitySurface,
  mediaSurface,
  paymentsSurface,
  storeDoSurface,
  vectorizeSurface,
  type ErasureEnv,
  type ErasureSurface,
  type IdentityPort,
  type R2BucketLike,
  type StoreDoStub,
  type Subject,
} from '../cf/erasure';
import { ownedStoreIds } from '../lib/definer';
import { purgeStoreVectors } from '../lib/search/purge-store-vectors';
import { paymentsErasurePort } from './billing/payments-erasure';
import { auditLog } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import { sendAlert } from './alerts.service';
import { erasureEnabled } from '../cf/erasure';
import type { ClosureDeps } from './account-closure.service';

/** S3: the live state of the PDPL erasure flag, for the deep health check (it was invisible: unset everywhere). */
export function erasureFlagState(): 'enabled' | 'disabled' {
  const b = cfBindings() as ErasureEnv | undefined;
  return erasureEnabled({
    PDPL_CF_ERASURE_ENABLED: b?.PDPL_CF_ERASURE_ENABLED ?? process.env.PDPL_CF_ERASURE_ENABLED,
  })
    ? 'enabled'
    : 'disabled';
}

/**
 * The production wiring of the closure trigger: the surfaces the erasure job runs, from the Worker bindings. A surface
 * whose binding is missing makes the request fail loud (503) rather than silently skip data: an erasure that leaves a
 * surface out is not an erasure. The email-suppression surface has no production port yet (G6), so it is not wired;
 * see docs/rulings/M024-1.md.
 */
export function closureDeps(req: Request): ClosureDeps {
  const b = cfBindings() as (ErasureEnv & Record<string, unknown>) | undefined;
  const env: ErasureEnv = b ?? {};
  const need = <T>(v: T | undefined, name: string): T => {
    if (v === undefined || v === null)
      throw new AppError(503, 'ERASURE_BINDING_MISSING', `${name} is not bound`);
    return v;
  };
  const storesOf = async (s: Subject) => (s.kind === 'merchant' && s.storeId ? [s.storeId] : []);
  const storeDoSurf = (): ErasureSurface => {
    const ns = need(env.STORE_DO, 'STORE_DO');
    return storeDoSurface(id => ns.get(ns.idFromName(id)) as unknown as StoreDoStub, storesOf);
  };
  const identity = (): ErasureSurface => {
    const port = need(b?.ACCOUNTS as unknown as IdentityPort | undefined, 'ACCOUNTS');
    return identitySurface(port);
  };
  return {
    env,
    ownedStoreIds,
    ownerSurfaces: () => [
      storeDoSurf(),
      paymentsSurface(paymentsErasurePort, storesOf),
      mediaSurface(need(env.MEDIA_BUCKET as R2BucketLike | undefined, 'MEDIA_BUCKET')),
      ciSurface(need(env.CI_BUCKET as R2BucketLike | undefined, 'CI_BUCKET')),
      vectorizeSurface(purgeStoreVectors),
      identity(),
    ],
    staffSurfaces: () => [identity()],
    alert: (title, body) =>
      sendAlert({ level: 'p1', scope: 'platform', source: 'account.closure', title, body }),
    recordRequest: async (userId, requestId, stores) => {
      await auditLog({
        action: 'account.closure.requested',
        userId,
        resourceType: 'user',
        resourceId: userId,
        details: { requestId, stores },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    },
  };
}
