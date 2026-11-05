/**
 * Ruling NZ-PG-9: once every `platform_cutover.*` marker is set and the Worker has no Hyperdrive binding, a new store can only
 * be created on D1 + its StoreDO (`STORE_CREATE_ON_DO=1`, lib/store-create-do.ts); with the var unset the create path would
 * reach Postgres and fail on every sign-up. The var is a separate cutover step (set AFTER the platform copies, because a store
 * created on the DO inside the copy window could be removed by the copy's "delete D1 rows Postgres lacks" step), so this does
 * not set it: it makes the gap LOUD. `/health` carries `store_create`, and a P1 goes out (at most once per 6 hours per isolate).
 *
 * Staleness class: NEVER-stale, no cache (marker reads are the cutover module's own).
 */
import { cfBindings } from '../cf/bindings';
import { isWorkers } from './runtime';
import logger from './logger';
import { sendAlert } from '../services/alerts.service';
import {
  FAMILY_MODELS,
  platformFamilyOnD1,
  type PlatformFamily,
} from '../services/platform/cutover';

export type StoreCreateState = 'on' | 'pending-cutover' | 'misconfigured';

const ALERT_EVERY_MS = 6 * 60 * 60_000;
let lastAlert = 0;
/** Test seam. */
export const resetStoreCreateAlert = (): void => {
  lastAlert = 0;
};

/** True when every platform family marker exists in D1 (false without a D1 binding). */
export async function allCutoverMarkersSet(): Promise<boolean> {
  if (!(cfBindings() as { PLATFORM_DB?: unknown } | undefined)?.PLATFORM_DB) return false;
  const families = Object.keys(FAMILY_MODELS) as PlatformFamily[];
  return (await Promise.all(families.map(f => platformFamilyOnD1(f)))).every(Boolean);
}

/**
 * `on`: the var is `1`. `misconfigured`: a deployed Worker with all markers set, no Hyperdrive and the var unset.
 * `pending-cutover`: anything else (Postgres can still exist, so the legacy create path is still valid).
 */
export async function storeCreateState(
  env: NodeJS.ProcessEnv = process.env
): Promise<StoreCreateState> {
  if (env.STORE_CREATE_ON_DO === '1') return 'on';
  if (!isWorkers) return 'pending-cutover';
  const hyperdrive = (cfBindings() as { HYPERDRIVE?: unknown } | undefined)?.HYPERDRIVE;
  if (hyperdrive) return 'pending-cutover';
  return (await allCutoverMarkersSet()) ? 'misconfigured' : 'pending-cutover';
}

/** P1 once per 6 h per isolate while `storeCreateState` is `misconfigured`. Never throws. */
export async function alertIfStoreCreateMisconfigured(now = Date.now()): Promise<StoreCreateState> {
  try {
    const state = await storeCreateState();
    if (state === 'misconfigured' && now - lastAlert >= ALERT_EVERY_MS) {
      lastAlert = now;
      await sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'api.store_create_on_do_unset',
        title: 'Store creation is broken: STORE_CREATE_ON_DO is not 1',
        body:
          'Every platform_cutover marker is set and the Worker has no Postgres/Hyperdrive, but STORE_CREATE_ON_DO is unset, so ' +
          'creating a store would reach Postgres and fail. Set STORE_CREATE_ON_DO to "1" in apps/api/wrangler.jsonc and deploy ' +
          '(cutover step 7, docs/runbooks/cutover-cf.md).',
      });
    }
    return state;
  } catch (err) {
    logger.error({ err }, '[store-create-config] check failed');
    return 'pending-cutover';
  }
}
