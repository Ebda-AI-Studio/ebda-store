/**
 * Store creation on D1 + the StoreDO (NEON-ZERO-1 N-18, Ruling NZ-D11). A store created here has NO Postgres row:
 *   1. the D1 `stores` directory row is inserted with `storage_backend = 'do'` (its unique slug / domain indexes refuse a taken
 *      address before anything else exists),
 *   2. the StoreDO is bootstrapped (`store_profile`, `store_config`, the inactive default VAT rate, optionally the COD config),
 *   3. the platform rows (subscription / trial) are written by `writeNewStoreSubscription`, the ONE place that will move with N-10
 *      (D1 `store_subscriptions` is where those rows live for a store with no Postgres row),
 *   4. the chart of accounts is seeded by the existing DO path (`seedCoaForStore`, no transaction).
 * Not atomic across D1 and the DO: a failure in 2 deletes the D1 row again (compensation); steps 3-4 are idempotent and a retry of
 * the whole create is a new store id, so a failure there leaves a store that is retried by the caller deleting it (the error says so).
 *
 * Enabled by `STORE_CREATE_ON_DO=1` AND both bindings (PLATFORM_DB, STORE_DO). Off (the default) = the unchanged Postgres create.
 * Ruling NZ-D11a: default OFF until N-6 (store-access) and N-10 (billing readers) can serve a store with no Postgres row.
 */
import { randomUUID } from 'node:crypto';
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';
import { platformDb } from './platform-db';
import { storeDb } from './repo-factory';
import { invalidateStoreDirectory } from './store-directory';
import { seedCoaForStore } from '../services/accounting/account.service';
import { storeDo } from './store-backend';
import { DEFAULT_TRIAL_CHOICE, type TrialChoice } from '../services/billing/trial';
import { addDays, TRIAL_DAYS, TRIAL_PLAN_CODE } from '../services/billing/period';
import { STORE_PLAN_TO_PLAN_CODE } from '@ebda/shared';
import logger from './logger';
import { sendAlert } from '../services/alerts.service';

type LegacyPlan = 'free' | 'starter' | 'professional' | 'enterprise';

interface D1Stmt {
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): D1Stmt };
  batch(stmts: unknown[]): Promise<Array<{ meta?: { changes?: number } }>>;
}
const d1 = (): D1Like | undefined =>
  (cfBindings() as { PLATFORM_DB?: D1Like } | undefined)?.PLATFORM_DB;

/** True when a new store must be created on D1 + its DO. */
export function storeCreateOnDo(): boolean {
  const b = cfBindings() as { PLATFORM_DB?: unknown; STORE_DO?: unknown } | undefined;
  return process.env.STORE_CREATE_ON_DO === '1' && !!b?.PLATFORM_DB && !!b?.STORE_DO;
}

export interface NewDoStore {
  name: string;
  nameAr?: string | null;
  slug: string;
  domain?: string | null;
  /** True for an operator-assigned domain (trusted: active at once). */
  domainActive?: boolean;
  domainProvider?: string | null;
  ownerId: string;
  status: 'active' | 'inactive';
  plan: LegacyPlan;
  template?: string;
  timezone?: string;
  settings: Record<string, unknown>;
  theme: Record<string, unknown>;
  layoutSettings: Record<string, unknown>;
  vatRateHundredths: number;
  /** Signup trial (first store): Growth for 14 days, the chosen plan waits in pending_plan_code. */
  trial?: { choice?: TrialChoice };
  /** Atomic plan gate: the insert is refused unless the owner has fewer than this many live stores in D1 (fails closed). */
  maxOwnedStores?: number | null;
  cod?: { name: string; nameAr: string; currency: string };
}

const isUnique = (e: unknown) =>
  /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));

/** Steps 1 and 2. Returns the new store id. */
export async function insertDoStore(input: NewDoStore): Promise<string> {
  const db = d1();
  if (!db) throw new AppError(503, 'PLATFORM_DB_UNBOUND', 'Platform database is not bound');
  const id = randomUUID();
  const now = Date.now();
  const cols: Record<string, unknown> = {
    id,
    name: input.name,
    name_ar: input.nameAr ?? null,
    slug: input.slug,
    domain: input.domain ?? null,
    domain_status: input.domain ? (input.domainActive === false ? 'pending' : 'active') : null,
    domain_verified_at: input.domain && input.domainActive !== false ? now : null,
    domain_provider: input.domainProvider ?? null,
    owner_id: input.ownerId,
    status: input.status,
    plan: input.plan,
    created_at: now,
    updated_at: now,
    storage_backend: 'do',
    ...(input.template ? { template: input.template } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
  };
  const names = Object.keys(cols);
  const cols2 = names.map(n => `"${n}"`).join(', ');
  const limited = typeof input.maxOwnedStores === 'number';
  const storeStmt = db
    .prepare(
      limited
        ? `INSERT INTO "stores" (${cols2}) SELECT ${names.map(() => '?').join(', ')} WHERE (SELECT COUNT(*) FROM "stores" WHERE "owner_id" = ? AND "deleted_at" IS NULL) < ?`
        : `INSERT INTO "stores" (${cols2}) VALUES (${names.map(() => '?').join(', ')})`
    )
    .bind(...names.map(n => cols[n]), ...(limited ? [input.ownerId, input.maxOwnedStores] : []));
  // The subscription (and trial) rows go in the SAME atomic batch as the store: no window where a store exists without them.
  const sub = newSubscriptionRow(id, input.plan, input.trial, new Date(now));
  const subNames = Object.keys(sub);
  const subStmt = db
    .prepare(
      `INSERT INTO "store_subscriptions" (${subNames.map(n => `"${n}"`).join(', ')}) SELECT ${subNames.map(() => '?').join(', ')} WHERE EXISTS (SELECT 1 FROM "stores" WHERE "id" = ?)`
    )
    .bind(...subNames.map(n => sub[n]), id);
  try {
    const res = await db.batch([storeStmt, subStmt]);
    if (res[0]?.meta?.changes === 0)
      throw new AppError(409, 'STORE_LIMIT_REACHED', 'Store limit reached for this account');
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (isUnique(e)) throw new AppError(409, 'SLUG_TAKEN', 'This store address is already taken');
    throw new AppError(503, 'STORE_DIRECTORY_UNAVAILABLE', 'Store directory write failed');
  }

  try {
    const { encodeRpc } = await import('@ebda-src/repo');
    const r = await storeDo(id).bootstrapStore(
      id,
      encodeRpc({
        identity: { name: input.name, slug: input.slug, ownerId: input.ownerId },
        fields: {
          name: input.name,
          ...(input.nameAr ? { nameAr: input.nameAr } : {}),
          slug: input.slug,
          domain: input.domain ?? null,
          ownerId: input.ownerId,
          status: input.status,
          plan: input.plan,
          ...(input.template ? { template: input.template } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          settings: input.settings,
          theme: input.theme,
          layoutSettings: input.layoutSettings,
        },
        vat: {
          id: randomUUID(),
          name: 'VAT',
          nameAr: 'ضريبة القيمة المضافة',
          rate: input.vatRateHundredths,
        },
        ...(input.cod ? { cod: { id: randomUUID(), ...input.cod } } : {}),
      })
    );
    if (!r.ok) throw new AppError(r.status ?? 502, r.code, `store bootstrap refused: ${r.code}`);
  } catch (e) {
    // Compensation: a directory row without a bootstrapped DO would resolve to a store that cannot serve.
    await rollbackDoStore(id, 'bootstrap');
    throw e instanceof AppError
      ? e
      : new AppError(502, 'STORE_BOOTSTRAP_FAILED', 'Store setup failed');
  }
  return id;
}

/**
 * The `store_subscriptions` row of a new store with no Postgres row (what `syncSubscriptionFromLegacyPlan` + `startSignupTrial` write,
 * computed once so it goes in the store's own atomic D1 batch). THE single place N-10 swaps when the billing writers move to D1.
 */
export function newSubscriptionRow(
  storeId: string,
  plan: LegacyPlan,
  trial: { choice?: TrialChoice } | undefined,
  now: Date
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: randomUUID(),
    store_id: storeId,
    plan_code: STORE_PLAN_TO_PLAN_CODE[plan],
    status: 'active',
  };
  if (!trial) return base;
  const choice = trial.choice ?? DEFAULT_TRIAL_CHOICE;
  const end = addDays(now, TRIAL_DAYS);
  return {
    ...base,
    plan_code: TRIAL_PLAN_CODE,
    status: 'trialing',
    trial_ends_at: end.getTime(),
    current_period_start: now.getTime(),
    current_period_end: end.getTime(),
    pending_plan_code: choice.planCode,
    billing_interval: choice.interval,
  };
}

/**
 * Remove a just-created store from D1 (its subscription cascades). A failed rollback is NEVER silent: it would leave a `do` row
 * with a bootstrapped DO, a reserved slug and a count against the owner, so it is a P1 alert plus an error log. (No reconciler sweep:
 * stores migrated from Postgres are `do` rows whose subscription is still in Postgres, so "do row without a subscription" is not
 * yet a safe orphan test; N-10 adds it.)
 */
export async function rollbackDoStore(storeId: string, stage: string): Promise<void> {
  try {
    await d1()!.prepare('DELETE FROM "stores" WHERE "id" = ?').bind(storeId).run();
  } catch (e) {
    logger.error({ err: e, storeId, stage }, '[STORE_CREATE_DO] rollback failed: orphan do row');
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'store.create.do_rollback_failed',
      title: 'Store create failed and its D1 row could not be removed',
      body: `store ${storeId} (failed at ${stage}) is a D1 'do' row with a bootstrapped Durable Object: delete the stores row by hand.`,
      context: { storeId, stage },
    }).catch(() => undefined);
  }
}

/**
 * The chart of accounts, extra default rows and the directory cache bust, with compensation: if either fails the D1 directory row is removed again (the slug is
 * freed; the DO keeps only its bootstrap rows and its random id is never reused). Returns the stored record (D1 + DO), no Postgres.
 */
export async function finishDoStoreCreate(
  storeId: string,
  input: {
    slug: string;
    domain?: string | null;
    /** More default rows (provisioning's category); inside the same compensation. */
    extra?: () => Promise<void>;
  }
): Promise<Record<string, unknown>> {
  try {
    await seedCoaForStore(storeId);
    await input.extra?.();
  } catch (e) {
    await rollbackDoStore(storeId, 'finish');
    throw e;
  }
  // A slug probed before this store existed is negatively cached in the directory: clear it so the new store resolves at once.
  await invalidateStoreDirectory(storeId, input.slug, input.domain ?? null);
  const created = await (await storeDb(storeId)).store.findUnique({ where: { id: storeId } });
  if (!created)
    throw new AppError(500, 'STORE_CREATE_FAILED', 'Store was created but cannot be read');
  return created as Record<string, unknown>;
}

/** D1 read of an owner's live stores (raw; undefined where D1 is unbound). */
export async function listOwnerStoresD1(
  ownerId: string
): Promise<Array<{ id: string; createdAt: Date }> | undefined> {
  if (!(await platformDb())) return undefined;
  const { results } = await d1()!
    .prepare('SELECT id, created_at FROM stores WHERE owner_id = ? AND deleted_at IS NULL')
    .bind(ownerId)
    .all<{ id: string; created_at: number }>();
  return results.map(r => ({ id: r.id, createdAt: new Date(Number(r.created_at)) }));
}

/** A Postgres read that may be unreachable once stores live only in D1: that is "no Postgres stores", not a failure. */
async function pgTolerant<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (e) {
    logger.warn({ err: e }, '[STORE_CREATE_DO] postgres owner-store read failed; using D1 only');
    return empty;
  }
}

/**
 * The owner's live stores. Flag OFF: Postgres only (unchanged). Flag ON: while both backends can hold stores, the UNION of
 * Postgres and D1 by id, so a store whose directory mirror failed (or whose Postgres row is gone) is still counted.
 */
export async function ownerStores(
  ownerId: string,
  pg: () => Promise<Array<{ id: string; createdAt: Date }>>
): Promise<Array<{ id: string; createdAt: Date }>> {
  if (!storeCreateOnDo()) return pg();
  const [fromPg, fromD1] = await Promise.all([pgTolerant(pg, []), listOwnerStoresD1(ownerId)]);
  const byId = new Map(fromPg.map(r => [r.id, r]));
  for (const r of fromD1 ?? []) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()];
}

/** Number of live stores an owner has (see `ownerStores`: max of the backends when the flag is on). */
export async function countOwnerStores(
  ownerId: string,
  pg: () => Promise<number>
): Promise<number> {
  if (!storeCreateOnDo()) return pg();
  const [a, b] = await Promise.all([pgTolerant(pg, 0), listOwnerStoresD1(ownerId)]);
  return Math.max(a, b?.length ?? 0);
}

/** Stores an owner created since `since`, soft-deleted included (the squatting loop the daily cap stops); max of the backends when the flag is on. */
export async function countOwnerStoresCreatedSince(
  ownerId: string,
  since: Date,
  pg: () => Promise<number>
): Promise<number> {
  if (!storeCreateOnDo()) return pg();
  const row = await d1()!
    .prepare('SELECT COUNT(*) AS n FROM stores WHERE owner_id = ? AND created_at >= ?')
    .bind(ownerId, since.getTime())
    .first<{ n: number }>();
  return Math.max(await pgTolerant(pg, 0), Number(row?.n ?? 0));
}
