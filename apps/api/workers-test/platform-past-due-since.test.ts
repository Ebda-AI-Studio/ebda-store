/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

// WA-GRACE-1 on the platform D1 (ported from tests/integration/subscription-past-due-since.test.ts, which ran the Postgres
// trigger). `store_subscriptions.past_due_since` is maintained by the triggers in cf-schema 0002_invariants.sql, so every
// write path is covered: set once on the transition into past_due (a later retry does not move it), cleared on any other
// status, and set on an INSERT that is already past_due.
const e = env as unknown as {
  PLATFORM_DB: {
    prepare(sql: string): {
      bind(...v: unknown[]): {
        run(): Promise<unknown>;
        first<T = Record<string, unknown>>(): Promise<T | null>;
      };
    };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
};
const db = e.PLATFORM_DB;
const STORE = 'pdsince-store';

const run = (sql: string, ...v: unknown[]) =>
  db
    .prepare(sql)
    .bind(...v)
    .run();
const since = async (): Promise<number | null> =>
  (
    await db
      .prepare('SELECT past_due_since AS s FROM store_subscriptions WHERE store_id = ?1')
      .bind(STORE)
      .first<{ s: number | null }>()
  )?.s ?? null;
const setStatus = (status: string, extra = '') =>
  run(`UPDATE store_subscriptions SET status = ?1${extra} WHERE store_id = ?2`, status, STORE);
const insertSub = (status: string) =>
  run(
    'INSERT INTO store_subscriptions (id, store_id, plan_code, status) VALUES (?1, ?2, ?3, ?4)',
    crypto.randomUUID(),
    STORE,
    'business',
    status
  );
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('store_subscriptions.past_due_since trigger on the platform D1', () => {
  beforeAll(async () => {
    await applyD1Migrations(db as never, e.TEST_PLATFORM_MIGRATIONS as never);
    await run(
      `INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, limits) VALUES ('plan-business', 'business', 'Business', 'Business', '{}')`
    );
    await run(
      'INSERT OR IGNORE INTO stores (id, name, slug, owner_id) VALUES (?1, ?1, ?1, ?2)',
      STORE,
      'owner-pd'
    );
    await insertSub('active');
  });

  it('is null while active, set on the first transition into past_due', async () => {
    expect(await since()).toBeNull();
    await setStatus('past_due');
    expect(typeof (await since())).toBe('number');
  });

  it('a later failed retry does not move it', async () => {
    const first = await since();
    await sleep(25);
    await setStatus('past_due', ', dunning_attempts = 2');
    expect(await since()).toBe(first);
  });

  it('is cleared on recovery, and a NEW past_due episode starts a new date', async () => {
    const first = await since();
    await setStatus('active');
    expect(await since()).toBeNull();
    await sleep(25);
    await setStatus('past_due');
    expect((await since())!).toBeGreaterThan(first!);
  });

  it('an INSERT that is already past_due gets a date; any non-past_due insert stays null', async () => {
    await run('DELETE FROM store_subscriptions WHERE store_id = ?1', STORE);
    await insertSub('past_due');
    expect(typeof (await since())).toBe('number');
    await run('DELETE FROM store_subscriptions WHERE store_id = ?1', STORE);
    await insertSub('active');
    expect(await since()).toBeNull();
  });
});
