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
import { platformDb, requirePlatformDb } from './platform-db';
import { storeDb } from './repo-factory';
import { invalidateStoreDirectory } from './store-directory';
import { retireStoreDirectoryRow } from './store-directory-sync';
import { seedCoaForStore } from '../services/accounting/account.service';
import { storeDo } from './store-backend';
import { syncSubscriptionFromLegacyPlan } from '../services/plan-sync';
import { startSignupTrial, type TrialChoice } from '../services/billing/trial';

type LegacyPlan = 'free' | 'starter' | 'professional' | 'enterprise';

interface D1Like {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      run(): Promise<unknown>;
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
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
  cod?: { name: string; nameAr: string; currency: string };
}

const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(e instanceof Error ? e.message : '');

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
  try {
    await db
      .prepare(
        `INSERT INTO "stores" (${names.map(n => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
      )
      .bind(...names.map(n => cols[n]))
      .run();
  } catch (e) {
    if (isUnique(e))
      throw new AppError(409, 'ALREADY_EXISTS', 'A store with this address already exists');
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
    await db
      .prepare('DELETE FROM "stores" WHERE "id" = ?')
      .bind(id)
      .run()
      .catch(() => undefined);
    throw e instanceof AppError
      ? e
      : new AppError(502, 'STORE_BOOTSTRAP_FAILED', 'Store setup failed');
  }
  return id;
}

/**
 * Step 3: the subscription row (and the signup trial) of a store that has no Postgres row. The existing ports
 * (`syncSubscriptionFromLegacyPlan`, `startSignupTrial`) take any client exposing `storeSubscription`; the platform D1 client
 * does (create / upsert / update / findUnique). THE single place N-10 swaps when the billing readers move to D1.
 */
export async function writeNewStoreSubscription(
  storeId: string,
  plan: LegacyPlan,
  trial?: { choice?: TrialChoice }
): Promise<void> {
  const platform = await requirePlatformDb();
  const db = { storeSubscription: platform.storeSubscription } as never;
  await syncSubscriptionFromLegacyPlan(db, storeId, plan);
  if (trial) await startSignupTrial(db, storeId, trial.choice);
}

/**
 * Steps 3 and 4 plus the directory cache bust, with compensation: if either fails the D1 directory row is removed again (the slug is
 * freed; the DO keeps only its bootstrap rows and its random id is never reused). Returns the stored record (D1 + DO), no Postgres.
 */
export async function finishDoStoreCreate(
  storeId: string,
  input: {
    slug: string;
    domain?: string | null;
    plan: LegacyPlan;
    trial?: { choice?: TrialChoice };
    /** More default rows (provisioning's category); inside the same compensation. */
    extra?: () => Promise<void>;
  }
): Promise<Record<string, unknown>> {
  try {
    await writeNewStoreSubscription(storeId, input.plan, input.trial);
    await seedCoaForStore(storeId);
    await input.extra?.();
  } catch (e) {
    await retireStoreDirectoryRow(storeId, { soft: false }).catch(() => undefined);
    throw e;
  }
  // A slug probed before this store existed is negatively cached in the directory: clear it so the new store resolves at once.
  await invalidateStoreDirectory(storeId, input.slug, input.domain ?? null);
  const created = await (await storeDb(storeId)).store.findUnique({ where: { id: storeId } });
  if (!created)
    throw new AppError(500, 'STORE_CREATE_FAILED', 'Store was created but cannot be read');
  return created as Record<string, unknown>;
}

/** D1 read of an owner's live stores, oldest first (the plan gate and the owned-store count read this, not Postgres). */
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

/** Number of live stores an owner has: D1 where bound, else the caller's Postgres count. */
export async function countOwnerStores(
  ownerId: string,
  fallback: () => Promise<number>
): Promise<number> {
  const rows = await listOwnerStoresD1(ownerId);
  return rows ? rows.length : fallback();
}

/** Stores an owner created since `since`, soft-deleted ones included (the squatting loop the daily cap stops). D1 only; undefined where unbound. */
export async function countOwnerStoresCreatedSinceD1(
  ownerId: string,
  since: Date
): Promise<number | undefined> {
  if (!(await platformDb())) return undefined;
  const row = await d1()!
    .prepare('SELECT COUNT(*) AS n FROM stores WHERE owner_id = ? AND created_at >= ?')
    .bind(ownerId, since.getTime())
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}
