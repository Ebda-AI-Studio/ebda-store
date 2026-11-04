/**
 * NEON-ZERO-1 (N-10): the one-way switch that moves a platform table family from Postgres to D1.
 *
 * A family is on D1 exactly when D1 `system_settings` holds the row `platform_cutover.<family>`. Only
 * `scripts/cf/copy-platform-pg-to-d1.mjs --commit` (run by the controller) writes it, after copying and verifying the
 * family. Until then every call is served by Postgres exactly as before this change, so merging the code moves nothing
 * (Ruling NEON-ZERO-2: no dual-read, no split-brain: one marker, one source of truth per family).
 *
 * Staleness class of the marker read: BOUNDED, one-way. "On" is cached for the life of the isolate (the marker is never
 * removed, a rollback is a new deploy). "Off" is re-read at most every OFF_TTL_MS per isolate, so the flip reaches every
 * isolate within that window; the runbook runs the copy at low traffic. Binding absent (Node, unit tests, local dev) ->
 * always off. Marker unreadable -> 503 (fail closed: serving from the wrong store is worse than an error).
 */
import { cfBindings } from '../../cf/bindings';
import { AppError } from '../../middleware/error-handler';

export type PlatformFamily = 'billing';

/** Prisma model names (delegate form) that each family owns. */
export const FAMILY_MODELS: Record<PlatformFamily, readonly string[]> = {
  billing: [
    'plan',
    'storeSubscription',
    'billingEvent',
    'billingGrant',
    'billingReferral',
    'billingReminder',
    'billingWebhookEvent',
    'storeLifecycleEmail',
  ],
};

export const OFF_TTL_MS = 10_000;
export const cutoverKey = (family: PlatformFamily) => `platform_cutover.${family}`;

interface MarkerD1 {
  prepare(sql: string): {
    bind(...v: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
  };
}

const on = new Set<PlatformFamily>();
const offUntil = new Map<PlatformFamily, number>();
const inflight = new Map<PlatformFamily, Promise<boolean>>();

/** Test seam. */
export function resetCutoverCache(): void {
  on.clear();
  offUntil.clear();
  inflight.clear();
}

export async function platformFamilyOnD1(family: PlatformFamily): Promise<boolean> {
  if (on.has(family)) return true;
  const d1 = (cfBindings() as { PLATFORM_DB?: MarkerD1 } | undefined)?.PLATFORM_DB;
  if (!d1) return false;
  if ((offUntil.get(family) ?? 0) > Date.now()) return false;
  let p = inflight.get(family);
  if (!p) {
    p = (async () => {
      try {
        const row = await d1
          .prepare('SELECT 1 AS ok FROM system_settings WHERE key = ?1')
          .bind(cutoverKey(family))
          .first<{ ok: number }>();
        if (row) {
          on.add(family);
          return true;
        }
        offUntil.set(family, Date.now() + OFF_TTL_MS);
        return false;
      } catch {
        throw new AppError(503, 'PLATFORM_CUTOVER_UNREADABLE', 'Platform database is unavailable');
      } finally {
        inflight.delete(family);
      }
    })();
    inflight.set(family, p);
  }
  return p;
}

export function familyOfModel(model: string): PlatformFamily | undefined {
  for (const [family, models] of Object.entries(FAMILY_MODELS))
    if (models.includes(model)) return family as PlatformFamily;
  return undefined;
}
