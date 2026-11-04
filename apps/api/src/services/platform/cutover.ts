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

export type PlatformFamily = 'billing' | 'access';

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
  // NEON-ZERO-1 (N-6/N-7): store membership. The access gate, staff, staff invites and owner/staff listings.
  access: ['storeStaff', 'staffInvite'],
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

// ---- write freeze (copy window) --------------------------------------------------------------------------------------
// The copy script writes `platform_freeze.<family>` BEFORE it copies. While it exists, a WRITE to a family that is not on
// D1 yet is refused with a retryable 503 (reads keep working from Postgres), so no Postgres write can land between the
// copy and the flip, or in the isolate-cache window after it (the script holds the freeze until that window has passed and
// re-verifies). Staleness class: BOUNDED, FREEZE_TTL_MS per isolate; the script waits longer than that before copying.
export const FREEZE_TTL_MS = 5_000;
export const freezeKey = (family: PlatformFamily) => `platform_freeze.${family}`;
const freezeCache = new Map<PlatformFamily, { frozen: boolean; until: number }>();

export function resetFreezeCache(): void {
  freezeCache.clear();
}

/** Throws a retryable 503 when `family` is frozen for a copy. Call only for writes that would go to Postgres. */
export async function assertFamilyNotFrozen(family: PlatformFamily): Promise<void> {
  const d1 = (cfBindings() as { PLATFORM_DB?: MarkerD1 } | undefined)?.PLATFORM_DB;
  if (!d1) return;
  let c = freezeCache.get(family);
  if (!c || c.until <= Date.now()) {
    try {
      const row = await d1
        .prepare('SELECT 1 AS ok FROM system_settings WHERE key = ?1')
        .bind(freezeKey(family))
        .first<{ ok: number }>();
      c = { frozen: !!row, until: Date.now() + FREEZE_TTL_MS };
      freezeCache.set(family, c);
    } catch {
      throw new AppError(503, 'PLATFORM_CUTOVER_UNREADABLE', 'Platform database is unavailable');
    }
  }
  if (c.frozen)
    throw new AppError(
      503,
      'PLATFORM_FAMILY_FROZEN',
      'This data is being moved; retry in a minute',
      { retryAfterSeconds: 30 }
    );
}

export function familyOfModel(model: string): PlatformFamily | undefined {
  for (const [family, models] of Object.entries(FAMILY_MODELS))
    if (models.includes(model)) return family as PlatformFamily;
  return undefined;
}
