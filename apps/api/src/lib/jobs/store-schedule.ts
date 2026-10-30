/** Client side of the StoreSchedule DO: which entries a store gets, arming one store, and the sync of all. */
import { storeDirectory } from '@ebda/database';
import { cfBindings } from '../../cf/bindings';
import type { ScheduleEntry, ScheduleRow } from '../../cf/store-schedule';
import { jobRunsOnAlarm } from './alarm-flag';
import { doStoreIds } from './do-guard';
import { allJobs } from './registry';
import logger from '../logger';

interface ScheduleStub {
  arm(storeId: string, entries: ScheduleEntry[]): Promise<ScheduleRow[]>;
}

/** Every alarm-enabled job with its (first) cron expression. */
export function alarmEntries(): ScheduleEntry[] {
  return allJobs()
    .filter(j => jobRunsOnAlarm(j.id))
    .flatMap(j => {
      const cron = j.options.triggers?.find(t => t.cron)?.cron;
      return cron ? [{ job: j.id, cron }] : [];
    });
}

function stub(storeId: string): ScheduleStub | undefined {
  const ns = cfBindings()?.STORE_SCHEDULE;
  return ns ? (ns.get(ns.idFromName(storeId)) as unknown as ScheduleStub) : undefined;
}

/**
 * Arm (or re-arm) one store's schedule. Alarms exist ONLY for stores served by their Durable Object (Ruling CF-JOBS-1):
 * a Postgres store keeps today's path, the global cron. No-op without the binding or for a Postgres store.
 */
export async function armStoreSchedule(storeId: string): Promise<void> {
  if (!(await doStoreIds()).has(storeId)) return;
  await stub(storeId)?.arm(storeId, alarmEntries());
}

/**
 * The safety net (hourly Cron Trigger): every live DO store has its schedule armed and current, so
 * flipping `JOBS_CF_ALARMS` or a store's backend flag takes effect within the hour and a store created while an arm failed
 * is picked up. Bounded concurrency; one failing store never stops the others.
 */
export async function syncStoreSchedules(
  concurrency = 10
): Promise<{ stores: number; failed: number }> {
  if (!cfBindings()?.STORE_SCHEDULE) return { stores: 0, failed: 0 };
  const dos = await doStoreIds();
  if (dos.size === 0) return { stores: 0, failed: 0 };
  const stores = (await storeDirectory()).filter(s => dos.has(s.id));
  const entries = alarmEntries();
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= stores.length) return;
      try {
        await stub(stores[i].id)?.arm(stores[i].id, entries);
      } catch (err) {
        failed += 1;
        logger.error({ err, storeId: stores[i].id }, '[store-schedule] arm failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, stores.length || 1) }, worker));
  return { stores: stores.length, failed };
}
