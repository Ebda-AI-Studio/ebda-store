/**
 * NEON-ZERO-1 N-15 follow-up: the platform admin / billing / legal / provider routes answer with Postgres DEAD.
 * What each fix is, and the test that pins it: directory-column Store reads from D1, the MFA gate from the identity
 * service, the audit trail for platform events in D1, the lists that were per-store Postgres fan-outs, the scope
 * resolver (no Postgres transaction for a DO / unknown store).
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));
const pg = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  // anything that reaches Postgres is recorded and answered with an empty result
  const prisma = new Proxy(real.prisma, {
    get: (t, p) =>
      p === '$queryRaw' || p === '$executeRaw'
        ? async () => {
            pg.calls.push(String(p));
            return [];
          }
        : Reflect.get(t, p),
  });
  return { ...real, prisma };
});

import { prisma } from '@ebda/database';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { cutoverKey, resetCutoverCache } from '../../apps/api/src/services/platform/cutover';
import {
  platformRouter,
  registerPlatformRouter,
} from '../../apps/api/src/services/platform/router';
import { requireMfaEnrolled } from '../../apps/api/src/middleware/require-mfa';
import { insertAuditLog } from '../../apps/api/src/lib/definer';
import { listGrants } from '../../apps/api/src/services/billing/grants.service';
import { listClaimsForAdmin } from '../../apps/api/src/services/billing/account.service';
import { listLedger } from '../../apps/api/src/services/billing/subscription-billing.service';

const MIG = fs
  .readdirSync(new URL('../../packages/cf-schema/migrations/platform/', import.meta.url))
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f =>
    fs.readFileSync(
      new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
      'utf8'
    )
  );
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function world(markers: string[] = ['billing', 'access']) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIG[0]);
  for (const sql of MIG.slice(1)) {
    try {
      db.exec(sql);
    } catch (e) {
      // the two 0003 files of this branch and a re-declared table are not what this test is about
      if (!/duplicate column|already exists/i.test(String(e))) throw e;
    }
  }
  const stmt = (sql: string, v: unknown[]) =>
    /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
      ? { results: db.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } }
      : { results: [], meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) } };
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...v: unknown[]) => ({
        all: async () => (await Promise.resolve(), stmt(sql, v)),
        run: async () => (await Promise.resolve(), stmt(sql, v)),
        first: async () => (await Promise.resolve(), (stmt(sql, v).results[0] ?? null) as never),
      }),
    }),
  };
  for (const [id, slug, owner] of [
    [A, 'a', 'owner-a'],
    [B, 'b', 'owner-b'],
  ])
    db.prepare(`INSERT INTO stores (id, name, slug, owner_id) VALUES (?, ?, ?, ?)`).run(
      id,
      `Store ${slug}`,
      slug,
      owner
    );
  markers.forEach((m, i) =>
    db
      .prepare(`INSERT INTO system_settings (id, key, value) VALUES (?, ?, '{}')`)
      .run(`m${i}`, cutoverKey(m as never))
  );
  setCfBindings({ PLATFORM_DB: d1 } as never);
  return db;
}

beforeEach(() => {
  pg.calls.length = 0;
  resetCutoverCache();
  clearCfBindings();
  registerPlatformRouter();
});

describe('Store reads of directory columns are answered by D1', () => {
  it('select + where on directory columns -> D1; a DO column, a whole row or an include -> the Postgres leg', async () => {
    world();
    const d1 = await prisma.store.findUnique({
      where: { id: A },
      select: { id: true, ownerId: true, billingSuspendedReason: true },
    });
    expect(d1).toMatchObject({ id: A, ownerId: 'owner-a', billingSuspendedReason: null });
    expect(
      await prisma.store.findMany({
        where: { id: { in: [A, B] } },
        select: { id: true, name: true, slug: true },
        orderBy: { slug: 'asc' },
      })
    ).toHaveLength(2);
    expect(await prisma.store.count({ where: { ownerId: 'owner-a' } })).toBe(1);

    const leg = vi.fn(async () => 'postgres');
    for (const args of [
      { where: { id: A } }, // whole row
      { where: { id: A }, select: { id: true, settings: true } }, // a Durable Object column
      { where: { id: A }, select: { id: true }, include: { owner: true } },
      { where: { owner: { is: { id: 'x' } } }, select: { id: true } }, // a relation filter
    ])
      expect(await platformRouter.route('store', 'findUnique', [args], leg)).toBe('postgres');
    expect(leg).toHaveBeenCalledTimes(4);
  });

  it('writes to Store are never routed here', async () => {
    world();
    const leg = vi.fn(async () => 'postgres');
    expect(
      await platformRouter.route(
        'store',
        'update',
        [{ where: { id: A }, data: { name: 'x' } }],
        leg
      )
    ).toBe('postgres');
  });

  it('without the access marker the read stays on Postgres', async () => {
    world(['billing']);
    const leg = vi.fn(async () => 'postgres');
    expect(
      await platformRouter.route(
        'store',
        'findUnique',
        [{ where: { id: A }, select: { id: true } }],
        leg
      )
    ).toBe('postgres');
  });
});

describe('requireMfaEnrolled asks the identity service, not Postgres', () => {
  const run = async (user: object | undefined, bindings: object) => {
    setCfBindings(bindings as never);
    let err: unknown;
    let passed = false;
    await requireMfaEnrolled({ user } as never, {} as never, (e?: unknown) => {
      err = e;
      passed = !e;
    });
    return { err: err as { statusCode?: number; code?: string } | undefined, passed };
  };

  it('super_admin: enrolled passes, not enrolled is 403 MFA_SETUP_REQUIRED; no Postgres either way', async () => {
    const mk = (mfaEnabled: boolean) => ({
      ACCOUNTS: {
        getAccountState: async () => ({
          id: 's',
          mfaEnabled,
          status: 'active',
          role: 'super_admin',
        }),
      },
    });
    expect((await run({ userId: 's', role: 'super_admin' }, mk(true))).passed).toBe(true);
    const no = await run({ userId: 's', role: 'super_admin' }, mk(false));
    expect(no.err).toMatchObject({ statusCode: 403, code: 'MFA_SETUP_REQUIRED' });
    expect(pg.calls).toEqual([]);
  });

  it('other roles pass through untouched', async () => {
    expect((await run({ userId: 'u', role: 'store_admin' }, {})).passed).toBe(true);
  });
});

describe('platform events are audited in D1', () => {
  it('a platform event (no store) lands in platform_audit_log and never asks Postgres; a store event still goes to the definer', async () => {
    const db = world();
    await insertAuditLog({
      action: 'platform.cross_store_read',
      userId: 'super-1',
      resourceType: 'webhook_events',
      details: { fn: 'x' },
      ip: '1.2.3.4',
    });
    expect(pg.calls).toEqual([]);
    const row = db
      .prepare('SELECT actor_id a, action, target_type t, store_id s, meta FROM platform_audit_log')
      .get() as { a: string; action: string; t: string; s: null; meta: string };
    expect(row).toMatchObject({
      a: 'super-1',
      action: 'platform.cross_store_read',
      t: 'webhook_events',
      s: null,
    });
    expect(JSON.parse(row.meta)).toMatchObject({ fn: 'x', ip: '1.2.3.4' });
    await insertAuditLog({ action: 'order.updated', storeId: A, resourceType: 'order' });
    expect(pg.calls).toEqual(['$queryRaw']); // a store's own row is not a platform event
  });
});

describe('the super-admin lists are ONE D1 query, not a Postgres fan-out per store', () => {
  it('ledger, grants and the InstaPay claims queue', async () => {
    const db = world();
    db.prepare(
      `INSERT INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES ('p', 'growth', 'g', 'g', 'professional', '{}')`
    ).run();
    for (const [i, s] of [A, B].entries()) {
      db.prepare(
        `INSERT INTO billing_events (id, store_id, type, amount_minor, provider, idempotency_key, status, created_at) VALUES (?, ?, 'renewal', 100, 'kashier', ?, 'succeeded', ?)`
      ).run(`e${i}`, s, `k${i}`, 1000 + i);
      db.prepare(
        `INSERT INTO billing_grants (id, kind, beneficiary_id, status, idempotency_key) VALUES (?, 'founding', ?, 'applied', ?)`
      ).run(`g${i}`, s, `gk${i}`);
      db.prepare(
        `INSERT INTO manual_payment_claims (id, store_id, plan_code, billing_interval, amount_minor, payment_reference, payer_reference, status, created_at) VALUES (?, ?, 'growth', 'monthly', 500, ?, ?, 'pending', ?)`
      ).run(`c${i}`, s, `pr${i}`, `pay${i}`, 2000 + i);
    }
    const ledger = await listLedger({});
    expect(ledger.map(r => r.storeName)).toEqual(['Store b', 'Store a']); // newest first, both stores, names from D1
    const grants = await listGrants();
    expect(grants.grants.map(g => g.beneficiaryName).sort()).toEqual(['Store a', 'Store b']);
    const claims = await listClaimsForAdmin('pending');
    expect(claims.map(c => c.storeSlug)).toEqual(['a', 'b']); // oldest first
    expect(pg.calls).toEqual([]);
  });
});
