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

export type PlatformFamily = 'billing' | 'access' | 'platform' | 'inbox' | 'ai-usage' | 'analytics';

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
    // the InstaPay claims and receipts of a subscription payment (and the order receipts of a Postgres store)
    'manualPaymentClaim',
    'instapayReceipt',
  ],
  // NEON-ZERO-1 (N-6/N-7): store membership. The access gate, staff, staff invites and owner/staff listings.
  access: ['storeStaff', 'staffInvite'],
  // N-10b. Everything else in the platform D1 that the API reads or writes by model and that has no ledger coupling.
  platform: [
    'systemSetting',
    'storeFeature',
    'legalAcceptance',
    'legalNoticeSend',
    'legalNoticeDelivery',
    'providerVerification',
    'providerVerificationEvent',
    'providerActivationRequest',
    'merchantApiKey',
    'slugRedirect',
  ],
  // The payment-webhook inbox: reached only through SQL definers (services/platform/inbox-d1.ts), its own marker because
  // its writers (provider callbacks) run on a different cadence from the admin surface.
  inbox: ['webhookEvent'],
  // Ruling NZ-AN-1: the AI quota counts usage across stores, so `ai_usage` is one platform table on D1 (append-only)
  'ai-usage': ['aiUsage'],
  // Ruling NZ-AN-1: no routed model. The marker + freeze only gate WHEN a Durable Object store's per-store analytics tables
  // (search/product-view/qr/notification/gsc) start being served by its DO (lib/analytics-backend.ts)
  analytics: [],
};

export const OFF_TTL_MS = 10_000;
export const cutoverKey = (family: PlatformFamily) => `platform_cutover.${family}`;
export const freezeKey = (family: PlatformFamily) => `platform_freeze.${family}`;

export interface MarkerD1 {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    };
  };
}

const on = new Set<PlatformFamily>();
const offUntil = new Map<PlatformFamily, number>();

/** Test seam. */
export function resetCutoverCache(): void {
  on.clear();
  offUntil.clear();
  expiredFreezeAlerted.clear();
}

const binding = () => (cfBindings() as { PLATFORM_DB?: MarkerD1 } | undefined)?.PLATFORM_DB;
const unreadable = () =>
  new AppError(503, 'PLATFORM_CUTOVER_UNREADABLE', 'Platform database is unavailable');

const expiredFreezeAlerted = new Set<string>();

/**
 * ONE marker + freeze mechanism for every cutover (billing/access/platform/inbox/ai-usage/analytics families AND the per-store
 * customer-auth marker of lib/customer-auth.ts, Ruling NZ-INTEG-1): the keys differ, the semantics do not. `markers` are the
 * `system_settings` keys whose presence means "moved"; `freezes` are the keys whose presence (unexpired) means "frozen".
 * A freeze row carries `{"expiresAt": <epoch ms>}`: past that instant it is IGNORED (a script killed without lifting it must not
 * stop the platform for ever) and a P1 names it, once per isolate per key. Unreadable D1 -> `unreadable()` (fail closed).
 */
export interface CutoverKeys {
  markers: readonly string[];
  freezes: readonly string[];
  unreadable: () => AppError;
  /** The operator command that removes the named freeze key (for the P1). */
  unfreezeHint: (freezeKey: string) => string;
  alertTitle: string;
}

export async function readCutoverKeys(
  d1: MarkerD1,
  k: CutoverKeys
): Promise<{ moved: boolean; frozen: boolean }> {
  const keys = [...k.markers, ...k.freezes];
  try {
    const rows =
      (
        await d1
          .prepare(
            `SELECT key, value FROM system_settings WHERE key IN (${keys.map((_, i) => `?${i + 1}`).join(',')})`
          )
          .bind(...keys)
          .all<{ key: string; value: string }>()
      ).results ?? [];
    let frozen = false;
    for (const r of rows) {
      if (!k.freezes.includes(r.key)) continue;
      let expiresAt = Number.POSITIVE_INFINITY;
      try {
        const parsed = JSON.parse(r.value) as { expiresAt?: unknown };
        if (typeof parsed.expiresAt === 'number') expiresAt = parsed.expiresAt;
      } catch {
        /* a freeze without a readable expiry is honoured */
      }
      if (expiresAt <= Date.now()) {
        if (!expiredFreezeAlerted.has(r.key)) {
          expiredFreezeAlerted.add(r.key);
          void sendAlert({
            level: 'p1',
            title: k.alertTitle,
            body: `${r.key} expired at ${new Date(expiresAt).toISOString()} and is being ignored. Remove it: ${k.unfreezeHint(r.key)}`,
          }).catch(() => undefined);
        }
        continue;
      }
      frozen = true;
    }
    return { moved: rows.some(r => k.markers.includes(r.key)), frozen };
  } catch {
    throw k.unreadable();
  }
}

const readKeys = (d1: MarkerD1, family: PlatformFamily) =>
  readCutoverKeys(d1, {
    markers: [cutoverKey(family)],
    freezes: [freezeKey(family)],
    unreadable,
    unfreezeHint: () => `node scripts/cf/cutover-platform-family.mjs --family ${family} --unfreeze`,
    alertTitle: 'Platform cutover: an expired freeze was left behind',
  });

/** Is the family frozen right now? Always a fresh read (no cache); false without a platform D1 binding. */
export async function isFamilyFrozen(family: PlatformFamily): Promise<boolean> {
  const d1 = binding();
  if (!d1) return false;
  return (await readKeys(d1, family)).frozen;
}

/** Throws the retryable 503 when the family is frozen (for Postgres-side writes that bypass the router). */
export async function assertNotFrozen(family: PlatformFamily): Promise<void> {
  if (await isFamilyFrozen(family)) throw frozenError(family);
}

/** Sync view for guards: has this isolate already seen the marker? */
export const isFamilyCachedOnD1 = (family: PlatformFamily): boolean => on.has(family);

const frozenError = (family: PlatformFamily) =>
  new AppError(503, 'PLATFORM_FAMILY_FROZEN', 'This data is being moved; retry in a minute', {
    retryable: true,
    family,
    retryAfterSeconds: 30,
    messageAr: 'بنحدّث بيانات الاشتراكات دلوقتي، جرّب تاني بعد دقيقة.',
  });

/**
 * READ path: cached "on" for good; "off" is cached for OFF_TTL_MS, but NEVER while a freeze row exists (the flip is
 * imminent: every read re-checks, so no isolate keeps reading Postgres for the cache's lifetime after the marker).
 */
export async function platformFamilyOnD1(family: PlatformFamily): Promise<boolean> {
  if (on.has(family)) return true;
  const d1 = binding();
  if (!d1) return false;
  if ((offUntil.get(family) ?? 0) > Date.now()) return false;
  const { moved, frozen } = await readKeys(d1, family);
  if (moved) {
    on.add(family);
    return true;
  }
  if (!frozen) offUntil.set(family, Date.now() + OFF_TTL_MS);
  return false;
}

/**
 * WRITE path: where this write goes, never from a stale "off". While a freeze exists EVERY write is refused (retryable
 * 503), marker or not: with the marker present but the freeze still up, isolates that have not seen the marker would
 * otherwise write Postgres while others write D1 (mixed backends). Only after the script lifts the freeze do writes
 * flow, and by then every isolate resolves the marker.
 */
export async function platformFamilyOnD1ForWrite(family: PlatformFamily): Promise<boolean> {
  if (on.has(family)) return true;
  const d1 = binding();
  if (!d1) return false;
  const { moved, frozen } = await readKeys(d1, family);
  if (frozen) throw frozenError(family);
  if (moved) {
    on.add(family);
    return true;
  }
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
