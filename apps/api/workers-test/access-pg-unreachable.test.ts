/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { accessToken, api, authState } from './helpers';

// NEON-ZERO-1 N-6/N-7: with Postgres unreachable and the `access` family flipped to D1, the store-access gate answers
// from D1 alone (owner / other owner / staff / removed staff / unknown store) and a membership change takes effect on the
// very next request. Run with EBDA_WORKERS_TEST_DB_URL pointing at a dead port (skipped when a database is reachable).
const e = env as unknown as {
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
};
const uid = () => crypto.randomUUID();
const STORE = uid();
const OWNER = uid();
const OTHER_OWNER = uid();
const STAFF = uid();
const NOT_STAFF = uid();
const D1 = e.PLATFORM_DB;

async function warm(userId: string): Promise<void> {
  // a warm token-version cache: the request needs no database
  await authState(`user:tv:${userId}`, [['set', `user:tv:${userId}`, '0', {}]]);
}
const get = async (userId: string, role: string, storeId = STORE) => {
  await warm(userId);
  const token = await accessToken({ userId, jti: uid(), role });
  return api.fetch(`https://api.ebda.app/api/v1/stores/${storeId}/products`, {
    headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '10.2.2.2' },
  });
};

describe.skipIf(e.E2E_DB === '1')(
  'store access gate with Postgres unreachable (access family on D1)',
  () => {
    it('owner ok, other owner 403, staff ok, removed staff 403, unknown store 404 - all from D1', async () => {
      await applyD1Migrations(D1 as never, e.TEST_PLATFORM_MIGRATIONS as never);
      await D1.prepare(
        'INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
      )
        .bind(STORE, 'gate', `gate-${STORE.slice(0, 8)}`, OWNER, 'do')
        .run();
      await D1.prepare('INSERT INTO store_staff (id, store_id, user_id) VALUES (?1, ?2, ?3)')
        .bind(uid(), STORE, STAFF)
        .run();
      await D1.prepare(
        "INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, 'platform_cutover.access', '{}')"
      )
        .bind(uid())
        .run();

      const owner = await get(OWNER, 'store_admin');
      expect(owner.status, await owner.clone().text()).toBeLessThan(400);
      expect((await get(OTHER_OWNER, 'store_admin')).status).toBe(403);
      expect((await get(STAFF, 'staff')).status).toBeLessThan(400);
      expect((await get(NOT_STAFF, 'staff')).status).toBe(403);
      expect((await get(OWNER, 'store_admin', uid())).status).toBe(404);

      // removal takes effect on the very next request (no membership cache anywhere)
      await D1.prepare('DELETE FROM store_staff WHERE user_id = ?1').bind(STAFF).run();
      expect((await get(STAFF, 'staff')).status).toBe(403);
    });
  }
);
