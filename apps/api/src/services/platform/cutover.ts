/**
 * NEON-ZERO-1 (N-10): the one-way switch that moves a platform table family from Postgres to D1.
 *
 * A family is on D1 exactly when D1 `system_settings` holds the row `platform_cutover.<family>`. Only
 * `scripts/cf/copy-platform-pg-to-d1.mjs --commit` (run by the controller) writes it, after copying and verifying the
 * family. Until then every call is served by Postgres exactly as before this change, so merging the code moves nothing
 * (Ruling NEON-ZERO-2: no dual-read, no split-brain: one marker, one source of truth per family).
 *
 * Staleness class of the marker read: "on" is cached for the life of the isolate (the marker is never removed, a rollback
 * is a new deploy). "Off" is cached at most OFF_TTL_MS for READS (a read may be served by Postgres for that long after the
 * flip: stale, never lost). A WRITE never trusts the cached "off": `familyStateForWrite` reads the marker and the freeze
 * flag from D1 on every write until the marker is seen, so a write after the flip always goes to D1.
 *
 * The copy runs behind a FREEZE (`system_settings.platform_freeze.<family>`, written by the script before it reads
 * Postgres): while it exists and the marker does not, every write to the family is refused with a retryable 503
 * (`PLATFORM_FAMILY_FROZEN`), so nothing can land in Postgres between the copy's snapshot and the flip.
 *
 * Binding absent (Node, unit tests, local dev) -> always off and writable. Marker unreadable -> 503 (fail closed: serving
 * from the wrong store is worse than an error). No shared in-flight promise: a promise created in one request must not
 * be awaited from another on workerd, so only resolved values are shared.
 */
import { cfBindings } from '../../cf/bindings';
import { AppError } from '../../middleware/error-handler';
import { sendAlert } from '../alerts.service';

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
/**
 * A freeze older than this is STUCK (the script died between freeze and lift): a stuck freeze would refuse every write of the
 * family for ever, which is an outage. It is then ignored (Postgres stays authoritative while no marker exists, so ignoring it
 * loses nothing) and a P1 alert fires once per isolate. The script aborts before the flip long before this (--max-freeze-ms).
 */
export const FREEZE_MAX_AGE_MS = 10 * 60_000;
export const cutoverKey = (family: PlatformFamily) => `platform_cutover.${family}`;
export const freezeKey = (family: PlatformFamily) => `platform_freeze.${family}`;

interface MarkerD1 {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    };
  };
}

const on = new Set<PlatformFamily>();
const staleAlerted = new Set<PlatformFamily>();
const offUntil = new Map<PlatformFamily, number>();

/** Test seam. */
export function resetCutoverCache(): void {
  on.clear();
  offUntil.clear();
  staleAlerted.clear();
}

const binding = () => (cfBindings() as { PLATFORM_DB?: MarkerD1 } | undefined)?.PLATFORM_DB;
const unreadable = () =>
  new AppError(503, 'PLATFORM_CUTOVER_UNREADABLE', 'Platform database is unavailable');

async function readKeys(
  d1: MarkerD1,
  family: PlatformFamily
): Promise<{ moved: boolean; frozen: boolean }> {
  try {
    const rows =
      (
        await d1
          .prepare('SELECT key, created_at FROM system_settings WHERE key IN (?1, ?2)')
          .bind(cutoverKey(family), freezeKey(family))
          .all<{ key: string; created_at: number | null }>()
      ).results ?? [];
    const freeze = rows.find(r => r.key === freezeKey(family));
    let frozen = !!freeze;
    if (freeze && Date.now() - Number(freeze.created_at ?? 0) > FREEZE_MAX_AGE_MS) {
      frozen = false;
      if (!staleAlerted.has(family)) {
        staleAlerted.add(family);
        void sendAlert({
          level: 'p1',
          source: 'platform.cutover.freeze_stuck',
          title: `platform_freeze.${family} is older than 10 minutes`,
          body: 'A cutover script died between freeze and lift. The freeze is ignored while no marker exists; remove it with --unfreeze.',
          context: { family, ageMs: Date.now() - Number(freeze.created_at ?? 0) },
        }).catch(() => undefined);
      }
    }
    return { moved: rows.some(r => r.key === cutoverKey(family)), frozen };
  } catch {
    throw unreadable();
  }
}

/** READ path: cached "on" for good, cached "off" for OFF_TTL_MS. */
export async function platformFamilyOnD1(family: PlatformFamily): Promise<boolean> {
  if (on.has(family)) return true;
  const d1 = binding();
  if (!d1) return false;
  if ((offUntil.get(family) ?? 0) > Date.now()) return false;
  const { moved } = await readKeys(d1, family);
  if (moved) {
    on.add(family);
    return true;
  }
  offUntil.set(family, Date.now() + OFF_TTL_MS);
  return false;
}

/**
 * WRITE path: where this write goes, never from a stale "off". Postgres is returned only after a fresh read showed no
 * marker AND no freeze; a freeze without a marker refuses the write (retryable 503).
 */
export async function platformFamilyOnD1ForWrite(family: PlatformFamily): Promise<boolean> {
  if (on.has(family)) return true;
  const d1 = binding();
  if (!d1) return false;
  const { moved, frozen } = await readKeys(d1, family);
  if (moved) {
    on.add(family);
    return true;
  }
  if (frozen)
    throw new AppError(
      503,
      'PLATFORM_FAMILY_FROZEN',
      'This data is being moved; retry in a minute',
      { retryable: true, family }
    );
  return false;
}

/** For a raw SQL write that bypasses the router (Postgres-only branch): throws when the family is frozen or moved. */
export async function assertFamilyWritableOnPostgres(family: PlatformFamily): Promise<void> {
  if (await platformFamilyOnD1ForWrite(family))
    throw new AppError(
      503,
      'PLATFORM_FAMILY_MOVED',
      'This data moved to D1; the Postgres write was refused',
      { retryable: true, family }
    );
}

export function familyOfModel(model: string): PlatformFamily | undefined {
  for (const [family, models] of Object.entries(FAMILY_MODELS))
    if (models.includes(model)) return family as PlatformFamily;
  return undefined;
}
