/**
 * NEON-ZERO (Ruling NZ-PG-1): `storeDirectory()` (packages/database) answered from D1 once the platform D1 is bound. The
 * entry is D1 `stores` (id, slug, name, status, plan, domain flags); the three per-store feature switches
 * (`accountingEnabled`, `aiFeaturesEnabled`, `loyaltyEnabled`) live in the StoreDO's `store_config`, not in D1.
 *
 * A caller's `filter` is the only thing that can need them. It is probed with every switch ON and every switch OFF: when both
 * answer the same the filter does not read a switch (no DO read at all); when they differ, the store's real switches are read
 * from its DO (bounded concurrency) and the filter is decided on them. A DO that cannot be read keeps the store in the list
 * (the job's own per-store gate decides, and the same failure surfaces there) with a warning: a sweep never loses a store to
 * a transient read. No Postgres fallback: D1 unreadable = 503 (`listDirectoryStores`).
 *
 * Staleness class: NEVER-stale, no cache (one fresh paged D1 read per call).
 */
import type { StoreDirectoryEntry } from '@ebda/database';
import logger from '../../lib/logger';
import { storeDb } from '../../lib/repo-factory';
import { platformDb } from '../../lib/platform-directory';
import { listDirectoryStores } from './directory-d1';

const SWITCH_READ_CONCURRENCY = 8;

type Switches = Pick<
  StoreDirectoryEntry,
  'accountingEnabled' | 'aiFeaturesEnabled' | 'loyaltyEnabled'
>;
const ALL_ON: Switches = { accountingEnabled: true, aiFeaturesEnabled: true, loyaltyEnabled: true };
const ALL_OFF: Switches = {
  accountingEnabled: false,
  aiFeaturesEnabled: false,
  loyaltyEnabled: false,
};

/** The store's real switches from its DO config; defaults match the DO schema (accounting + AI on, loyalty off). */
async function readSwitches(storeId: string): Promise<Switches> {
  const row = await (
    await storeDb(storeId)
  ).store.findUnique({
    where: { id: storeId },
    select: { accountingEnabled: true, aiFeaturesEnabled: true, loyaltyEnabled: true },
  });
  return {
    accountingEnabled: row?.accountingEnabled ?? true,
    aiFeaturesEnabled: row?.aiFeaturesEnabled ?? true,
    loyaltyEnabled: row?.loyaltyEnabled ?? false,
  };
}

export async function d1DirectoryEntries(opts: {
  includeDeleted: boolean;
  filter?: (s: StoreDirectoryEntry) => boolean;
}): Promise<StoreDirectoryEntry[] | undefined> {
  if (!platformDb()) return undefined;
  const stores = await listDirectoryStores({ includeDeleted: opts.includeDeleted });
  const base = stores.map(
    (s): StoreDirectoryEntry => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      status: s.status,
      plan: s.plan,
      ...ALL_ON,
      hasDomain: s.hasDomain,
      hasPendingDomain: s.hasPendingDomain,
    })
  );
  const { filter } = opts;
  if (!filter) return base;

  const decided: StoreDirectoryEntry[] = [];
  const needSwitches: StoreDirectoryEntry[] = [];
  for (const e of base) {
    const on = filter(e);
    const off = filter({ ...e, ...ALL_OFF });
    if (on === off) {
      if (on) decided.push(e);
    } else needSwitches.push(e); // the filter reads a switch (either polarity): ask the store
  }
  const resolved: StoreDirectoryEntry[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= needSwitches.length) return;
      const e = needSwitches[i];
      try {
        const real = { ...e, ...(await readSwitches(e.id)) };
        if (filter(real)) resolved.push(real);
      } catch (err) {
        logger.warn(
          { err, storeId: e.id },
          '[directory] switches unreadable; store kept in the list'
        );
        resolved.push(e);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SWITCH_READ_CONCURRENCY, needSwitches.length || 1) }, worker)
  );
  const keep = new Map([...decided, ...resolved].map(e => [e.id, e]));
  return base.flatMap(e => keep.get(e.id) ?? []);
}
