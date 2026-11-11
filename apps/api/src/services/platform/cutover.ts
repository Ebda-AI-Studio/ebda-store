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
import { postgresRemovedOnThisWorker } from '../../lib/postgres-present';
import { sweepMemo } from '../../lib/sweep-scope';

export type PlatformFamily =
  | 'billing'
  | 'access'
  | 'platform'
  | 'inbox'
  | 'ai-usage'
  | 'analytics'
  | 'payments'
  | 'ops'
  | 'audit';

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
  // N-10d. MONEY: the InstaPay receipts of the subscription flow (and of order flows of stores still on Postgres) and the
  // manual-payment claims a super-admin confirms into the billing ledger. Own marker (never folded into `billing`, whose
  // marker may already exist in production: adding models to a flipped family would serve them empty).
  payments: ['instapayReceipt', 'manualPaymentClaim'],
  // N-10d. Non-money platform tables: per-store monthly usage snapshots, platform CI findings, answer-engine provider keys.
  // NZ-C-11: + oneSignalSubscription, the admin / staff / super_admin push devices (user-keyed, no store).
  ops: ['answerEngineProviderConfig', 'storeUsageSnapshot', 'ciInsight', 'oneSignalSubscription'],
  // N-10d. The audit trail has no Prisma model on D1 (it is written through `services/audit-sink.ts`, never the router);
  // the marker only says "store-less audit rows go to D1 platform_audit_log and DO-store rows to their StoreDO".
  audit: [],
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
const missingMarkerAlerted = new Set<PlatformFamily>();

/** Test seam. */
export function resetCutoverCache(): void {
  on.clear();
  offUntil.clear();
  expiredFreezeAlerted.clear();
  missingMarkerAlerted.clear();
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

type CutoverRow = { key: string; value: string };

/** Pure: the {moved, frozen} verdict for ONE key set from the `system_settings` rows that were read for it (expiry + P1 included). */
function evaluateCutoverRows(
  rows: readonly CutoverRow[],
  k: CutoverKeys
): { moved: boolean; frozen: boolean } {
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
}

const selectKeysLive = async (d1: MarkerD1, keys: readonly string[]): Promise<CutoverRow[]> =>
  (
    await d1
      .prepare(
        `SELECT key, value FROM system_settings WHERE key IN (${keys.map((_, i) => `?${i + 1}`).join(',')})`
      )
      .bind(...keys)
      .all<CutoverRow>()
  ).results ?? [];

/**
 * STALENESS CLASS: BOUNDED-stale. Inside a cron job run / queue message (lib/sweep-scope.ts) the same key set is read once, not
 * once per store or per call (Sentry N+1: `SELECT key, value FROM system_settings WHERE key IN (...)` repeated in one run).
 * RESIDUAL WINDOW: at most OFF_TTL_MS (10 s) per key set, per invocation, never across invocations or isolates. Why safe: a
 * marker / freeze row is written by an operator script, not by the run itself; the in-process "off" verdict above already
 * tolerates the same 10 s, and an unreadable read still fails closed (503, a failed load is never kept). A freeze landing
 * mid-run is therefore seen within 10 s, exactly as without this memo. Request paths open no scope and keep the live read.
 */
const selectKeys = (d1: MarkerD1, keys: readonly string[]): Promise<CutoverRow[]> =>
  sweepMemo(
    `cutover-keys:${[...keys].sort().join('|')}`,
    () => selectKeysLive(d1, keys),
    OFF_TTL_MS
  );

export async function readCutoverKeys(
  d1: MarkerD1,
  k: CutoverKeys
): Promise<{ moved: boolean; frozen: boolean }> {
  try {
    return evaluateCutoverRows(await selectKeys(d1, [...k.markers, ...k.freezes]), k);
  } catch {
    throw k.unreadable();
  }
}

/** D1 allows 100 bound parameters per statement; stay under it. */
const MAX_KEYS_PER_READ = 90;

/**
 * `readCutoverKeys` for MANY key sets (one per store) in as few D1 reads as the 100-parameter limit allows: the union of
 * the keys is read once (shared keys deduped), then each set is judged by the SAME rules. Verdicts come back in `sets` order.
 * Replaces N sequential reads in a per-store sweep (Sentry EBDA-API-Z). Unreadable D1 -> the first set's `unreadable()`.
 */
export async function readCutoverKeysMany(
  d1: MarkerD1,
  sets: readonly CutoverKeys[]
): Promise<Array<{ moved: boolean; frozen: boolean }>> {
  if (sets.length === 0) return [];
  const unique = [...new Set(sets.flatMap(k => [...k.markers, ...k.freezes]))];
  const rows: CutoverRow[] = [];
  try {
    for (let i = 0; i < unique.length; i += MAX_KEYS_PER_READ)
      rows.push(...(await selectKeys(d1, unique.slice(i, i + MAX_KEYS_PER_READ))));
  } catch {
    throw sets[0]!.unreadable();
  }
  return sets.map(k => {
    const mine = new Set([...k.markers, ...k.freezes]);
    return evaluateCutoverRows(
      rows.filter(r => mine.has(r.key)),
      k
    );
  });
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
    messageAr: 'بنحدّث بيانات الدفع والاشتراكات دلوقتي، جرّب تاني بعد دقيقة.',
  });

/**
 * NEON-ZERO N-17 (Ruling NZ-D23): on a Worker with no Postgres an unflipped family has only ONE possible home, D1. "Off" there
 * is not "serve from Postgres", it is a Prisma call that throws POSTGRES_REMOVED on every use (P1 2026-11-09: `ai-usage` was never
 * flipped in production, so every AI quota check, the storefront and the weekly answer-engine scan included, threw). Such a family is
 * served by D1 and cached "on" for the isolate; a P1 names the missing marker once per isolate so the operator writes it.
 * Node / tests / local dev keep the marker semantics unchanged (Postgres is present there).
 */
function servedByD1BecausePostgresIsGone(family: PlatformFamily): boolean {
  if (!postgresRemovedOnThisWorker()) return false;
  on.add(family);
  if (!missingMarkerAlerted.has(family)) {
    missingMarkerAlerted.add(family);
    void sendAlert({
      level: 'p1',
      source: 'platform.cutover',
      title: `Platform family ${family} has no cutover marker; served by D1 (no Postgres on this Worker)`,
      body:
        `system_settings has no ${cutoverKey(family)} row in ebda-platform, but this Worker has no Postgres, so ${family} is ` +
        'served by D1. Write the marker (scripts/cf/cutover-platform-family.mjs) so the state on record matches what runs.',
      context: { family, marker: cutoverKey(family) },
    }).catch(() => undefined);
  }
  return true;
}

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
  if (servedByD1BecausePostgresIsGone(family)) return true;
  if (!frozen) offUntil.set(family, Date.now() + OFF_TTL_MS);
  return false;
}

/**
 * WRITE path: where this write goes, never from a stale "off". While a freeze exists an isolate that has NOT cached the
 * marker refuses the write (retryable 503), marker or not: otherwise it would write Postgres while others write D1 (mixed
 * backends). An isolate that HAS seen the marker ("on" is cached for the isolate's life, the first line below) writes D1 even
 * while the freeze row still exists: marker + freeze coexisting does NOT refuse every write (Ruling NZ-PG-5). Nothing writes
 * Postgres after the flip: the isolates that cannot decide refuse, they never fall back.
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
  return servedByD1BecausePostgresIsGone(family);
}

/**
 * AUDIT family (N-10d): where do STORE-LESS audit rows go right now? D1 once the marker exists OR while the copy script's
 * freeze is up (the freeze means "new rows already go to the new home": audit never refuses a write, it only redirects it;
 * the copy script then copies the Postgres history written before the freeze). Marker unreadable -> throws (the sink
 * queues the row for retry instead of guessing a home). No D1 binding -> false (Postgres, as before).
 */
export async function auditStoreLessOnD1(): Promise<boolean> {
  if (on.has('audit')) return true;
  const d1 = binding();
  if (!d1) return false;
  const { moved, frozen } = await readKeys(d1, 'audit');
  if (moved) {
    on.add('audit');
    return true;
  }
  return frozen || servedByD1BecausePostgresIsGone('audit');
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

/**
 * The ONE answer to "does a user-scoped request/call (no store) open a Postgres transaction?" (Ruling NZ-INTEG-1): no, once the
 * platform D1 is bound and the billing, access and platform families are all on it. Used by `userContext` and by the database
 * scope resolver. An unreadable marker throws the 503 of `platformFamilyOnD1` (never a Postgres guess).
 */
export async function platformUserScopeIsLazy(): Promise<boolean> {
  const [billing, access, platform] = await Promise.all([
    platformFamilyOnD1('billing'),
    platformFamilyOnD1('access'),
    platformFamilyOnD1('platform'),
  ]);
  return billing && access && platform;
}
