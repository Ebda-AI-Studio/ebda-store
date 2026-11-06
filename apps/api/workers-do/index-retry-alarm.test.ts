import { describe, expect, it } from 'vitest';
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { ensurePlatformIndex } from './platform-index';

// Ruling NZ-MONEY-2 (review I-2 of PR 455): a money op whose entity-index rows could not reach D1 arms a SHORT alarm; that
// alarm drains the rows and does NOT back the store up (the nightly backup runs only when it is due).
const e = env as unknown as {
  STORE_DO: DurableObjectNamespace<StoreDO>;
  STORE_BACKUPS: { list(o: { prefix: string }): Promise<{ objects: unknown[] }> };
  PLATFORM_DB: { exec(sql: string): Promise<unknown>; prepare(s: string): any };
};
const store = 'idx-retry-store';
const stub = () => e.STORE_DO.get(e.STORE_DO.idFromName(store));
const backups = async () =>
  (await e.STORE_BACKUPS.list({ prefix: `store-do-backups/${store}/` })).objects.length;

describe('entity-index retry alarm', () => {
  it('a queued row is drained by an early alarm that does not back up; the backup still runs when due', async () => {
    await ensurePlatformIndex();
    const s = stub();
    // bind the DO to its store and arm the nightly alarm (the due date is recorded with it)
    await s.moneyOp(store, 'trialBalance', '{}');
    await s.ensureBackupAlarm();
    // a row a money op could not write (D1 refused it once): backed off, next attempt in 5 s
    await runInDurableObject(s, async (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO d1_outbox (kind, payload, attempts, next_attempt_at, created_at) VALUES ('entity_index', ?, 1, ?, ?)",
        JSON.stringify({ kind: 'payment', id: 'pay-retry-1', storeId: store }),
        Date.now() + 5000,
        Date.now()
      );
    });
    // any money op leaves an early alarm for it (never later than the nightly one)
    await s.moneyOp(store, 'trialBalance', '{}');
    const alarmAt = await runInDurableObject(s, (_i, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    expect(alarmAt!).toBeLessThan(Date.now() + 60 * 60 * 1000);
    // the alarm fires when the row is due (runDurableObjectAlarm runs it now: make the row due now)
    await runInDurableObject(s, (_i, state) => {
      state.storage.sql.exec(
        "UPDATE d1_outbox SET next_attempt_at = ? WHERE kind = 'entity_index'",
        Date.now() - 1
      );
    });
    expect(await runDurableObjectAlarm(s)).toBe(true);
    const row = await e.PLATFORM_DB.prepare(
      "SELECT store_id FROM entity_index WHERE kind = 'payment' AND id = 'pay-retry-1'"
    ).first();
    expect(row).toEqual({ store_id: store });
    expect(await backups()).toBe(0); // the early alarm did not back the store up
    // re-armed for the nightly backup (nothing left in the outbox)
    const next = await runInDurableObject(s, (_i, state) => state.storage.getAlarm());
    expect(next!).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    // the backup still runs when it IS due
    await runInDurableObject(s, (_i, state) => {
      state.storage.sql.exec(
        "UPDATE _identity SET v = ? WHERE k = 'backup_due_at'",
        String(Date.now() - 1000)
      );
    });
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await backups()).toBeGreaterThan(0);
  });
});
