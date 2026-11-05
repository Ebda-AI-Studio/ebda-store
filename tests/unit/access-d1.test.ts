/**
 * NEON-ZERO-1 N-6 / N-7: the `access` family (store membership) on D1. Real platform migrations on node:sqlite wrapped as an
 * async D1. The Postgres side is never reached once the marker exists.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => 'sent'),
}));

import { prisma } from '@ebda/database';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import {
  cutoverKey,
  freezeKey,
  resetCutoverCache,
} from '../../apps/api/src/services/platform/cutover';
import { sendAlert } from '../../apps/api/src/services/alerts.service';
import { checkStoreAccess } from '../../apps/api/src/middleware/store-access';
import {
  platformRouter,
  registerPlatformRouter,
} from '../../apps/api/src/services/platform/router';
import {
  acceptInviteWithinCap,
  addStaffWithinCap,
  eraseUserAccess,
  gateRead,
  removeStaffMember,
  storeBriefsD1,
  liveStoreIdsD1,
  ownedStoreIdsD1,
} from '../../apps/api/src/services/platform/access-d1';

const MIG = ['0001_init.sql', '0002_invariants.sql']
  .map(f =>
    fs.readFileSync(
      new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
      'utf8'
    )
  )
  .join('\n');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner-1';
const U1 = 'user-1';
const U2 = 'user-2';
const U3 = 'user-3';

function rig() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIG);
  const log: string[] = [];
  const exec = (sql: string, v: unknown[]) => {
    log.push(sql);
    if (/^\s*(select|with)/i.test(sql) || /returning/i.test(sql))
      return { results: db.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } };
    return {
      results: [],
      meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) },
    };
  };
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...v: unknown[]) => ({
        __sql: sql,
        __v: v,
        all: async () => (await Promise.resolve(), exec(sql, v)),
        run: async () => (await Promise.resolve(), exec(sql, v)),
        first: async () => (await Promise.resolve(), (exec(sql, v).results[0] ?? null) as never),
      }),
    }),
    // D1 batch: all statements in one transaction, rolled back together on error.
    batch: async (stmts: Array<{ __sql: string; __v: unknown[] }>) => {
      await Promise.resolve();
      db.exec('BEGIN');
      try {
        const out = stmts.map(s => exec(s.__sql, s.__v));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const store = (id: string, slug: string, over: { status?: string; owner?: string } = {}) =>
    db
      .prepare(`INSERT INTO stores (id, name, slug, owner_id, status) VALUES (?, ?, ?, ?, ?)`)
      .run(id, slug, slug, over.owner ?? OWNER, over.status ?? 'active');
  const marker = () =>
    db
      .prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c1', ?, '{}')`)
      .run(cutoverKey('access'));
  const freeze = () =>
    db
      .prepare(`INSERT INTO system_settings (id, key, value) VALUES ('f1', ?, '{}')`)
      .run(freezeKey('access'));
  const staff = (store: string, user: string) =>
    db
      .prepare(`INSERT INTO store_staff (id, store_id, user_id) VALUES (?, ?, ?)`)
      .run(crypto.randomUUID(), store, user);
  const invite = (id: string, store: string, email: string, expiresInMs = 60_000) =>
    db
      .prepare(`INSERT INTO staff_invites (id, store_id, email, expires_at) VALUES (?, ?, ?, ?)`)
      .run(id, store, email, Date.now() + expiresInMs);
  const inviteStatus = (id: string) =>
    (db.prepare(`SELECT status FROM staff_invites WHERE id = ?`).get(id) as { status: string })
      .status;
  const seats = (store: string) =>
    (
      db.prepare(`SELECT count(*) AS n FROM store_staff WHERE store_id = ?`).get(store) as {
        n: number;
      }
    ).n;
  return { db, d1, log, store, marker, freeze, staff, invite, inviteStatus, seats };
}

beforeEach(() => {
  resetCutoverCache();
  clearCfBindings();
  registerPlatformRouter();
});

describe('family table list', () => {
  it('the copy script and the API router name the same tables', async () => {
    const { FAMILIES } = await import('../../scripts/cf/cutover-platform-family.mjs');
    const meta = (await import('../../packages/cf-schema/generated/prisma-meta.json')).default as {
      models: Record<string, { table: string; db: string }>;
    };
    const { FAMILY_MODELS } = await import('../../apps/api/src/services/platform/cutover');
    const tables = FAMILY_MODELS.access.map(m => {
      const model = meta.models[m[0].toUpperCase() + m.slice(1)];
      expect(model?.db, m).toBe('d1');
      return model.table;
    });
    expect([...tables].sort()).toEqual([...FAMILIES.access].sort());
  });
});

describe('the access gate read (N-6)', () => {
  it('owner, other user, staff, removed staff, unknown store - one D1 statement each', async () => {
    const r = rig();
    r.store(S1, 's1');
    r.staff(S1, U1);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);

    const owner = await gateRead(S1, OWNER);
    expect(owner?.store.ownerId).toBe(OWNER);
    expect(owner?.isStaff).toBe(false);
    expect((await gateRead(S1, U1))?.isStaff).toBe(true);
    expect((await gateRead(S1, U2))?.isStaff).toBe(false); // someone else's user
    expect(await gateRead(S2, U1)).toBeNull(); // unknown store -> 404 upstream

    r.db.prepare('DELETE FROM store_staff WHERE user_id = ?').run(U1); // removed staff
    expect((await gateRead(S1, U1))?.isStaff).toBe(false);

    const before = r.log.length;
    await gateRead(S1, U1);
    expect(r.log.length - before).toBe(1);
  });

  it('an unreadable D1 fails closed with 503, never an allow', async () => {
    setCfBindings({
      PLATFORM_DB: {
        prepare: () => ({ bind: () => ({ first: async () => Promise.reject(new Error('down')) }) }),
      },
    } as never);
    await expect(gateRead(S1, U1)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('owned stores and live-store filter come from the directory row', async () => {
    const r = rig();
    r.store(S1, 's1');
    r.store(S2, 's2');
    r.db.prepare('UPDATE stores SET deleted_at = ? WHERE id = ?').run(Date.now(), S2);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    expect(await ownedStoreIdsD1(OWNER)).toEqual([S1]);
    expect([...(await liveStoreIdsD1([S1, S2]))]).toEqual([S1]);
  });
});

describe('seat cap and invite accept (N-7)', () => {
  it('addStaffWithinCap takes seats up to the cap, never twice for one user', async () => {
    const r = rig();
    r.store(S1, 's1');
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    expect(await addStaffWithinCap(S1, U1, 2)).toBeTruthy();
    expect(await addStaffWithinCap(S1, U1, 2)).toBeNull(); // already a member
    expect(await addStaffWithinCap(S1, U2, 2)).toBeTruthy();
    expect(await addStaffWithinCap(S1, U3, 2)).toBeNull(); // cap full
    expect(r.seats(S1)).toBe(2);
    expect(await addStaffWithinCap(S1, U3, null)).toBeTruthy(); // unlimited
    expect(await addStaffWithinCap(S2, U1, 5)).toBeNull(); // no such store
  });

  it('two simultaneous adds cannot both take the last seat', async () => {
    const r = rig();
    r.store(S1, 's1');
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const got = await Promise.all([addStaffWithinCap(S1, U1, 1), addStaffWithinCap(S1, U2, 1)]);
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(r.seats(S1)).toBe(1);
  });

  it('accept: membership + consume together; a second accept is "already a member"', async () => {
    const r = rig();
    r.store(S1, 's1');
    r.invite('inv-1', S1, 'a@x.test');
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const input = { inviteId: 'inv-1', storeId: S1, email: 'a@x.test', userId: U1, cap: 3 };
    expect(await acceptInviteWithinCap(input)).toEqual({ added: true, consumed: true });
    expect(r.inviteStatus('inv-1')).toBe('accepted');
    expect(r.seats(S1)).toBe(1);
    expect(await acceptInviteWithinCap(input)).toEqual({ added: false, consumed: false });
    expect(r.seats(S1)).toBe(1);
  });

  it('accept with the seats full leaves the invitation PENDING (nothing burned)', async () => {
    const r = rig();
    r.store(S1, 's1');
    r.staff(S1, U2);
    r.invite('inv-1', S1, 'a@x.test');
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const out = await acceptInviteWithinCap({
      inviteId: 'inv-1',
      storeId: S1,
      email: 'a@x.test',
      userId: U1,
      cap: 1,
    });
    expect(out).toEqual({ added: false, consumed: false });
    expect(r.inviteStatus('inv-1')).toBe('pending');
    expect(r.seats(S1)).toBe(1);
  });

  it('expired, revoked, wrong-email and wrong-store invitations add nobody', async () => {
    const r = rig();
    r.store(S1, 's1');
    r.store(S2, 's2');
    r.invite('exp', S1, 'a@x.test', -1000);
    r.invite('rev', S1, 'a@x.test');
    r.db.prepare(`UPDATE staff_invites SET status = 'revoked' WHERE id = 'rev'`).run();
    r.invite('ok', S1, 'a@x.test');
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const base = { userId: U1, cap: 5 };
    for (const bad of [
      { inviteId: 'exp', storeId: S1, email: 'a@x.test' },
      { inviteId: 'rev', storeId: S1, email: 'a@x.test' },
      { inviteId: 'ok', storeId: S1, email: 'b@x.test' },
      { inviteId: 'ok', storeId: S2, email: 'a@x.test' },
    ])
      expect(await acceptInviteWithinCap({ ...bad, ...base })).toEqual({
        added: false,
        consumed: false,
      });
    expect(r.seats(S1)).toBe(0);
    expect(r.inviteStatus('ok')).toBe('pending');
  });
});

describe('routing through the prisma proxy', () => {
  it('before the marker membership goes to Postgres; after it, D1 only (Postgres never touched)', async () => {
    const r = rig();
    r.store(S1, 's1');
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const pg = vi.fn(async () => 'pg');
    expect(await platformRouter.route('storeStaff', 'findMany', [], pg)).toBe('pg');
    r.marker();
    resetCutoverCache();
    await prisma.storeStaff.create({ data: { storeId: S1, userId: U1 } });
    const rows = await prisma.storeStaff.findMany({ where: { storeId: S1 } });
    expect(rows.map((x: { userId: string }) => x.userId)).toEqual([U1]);
    expect(r.seats(S1)).toBe(1);
  });
});

describe('copy-window freeze (#407 mechanism, access family)', () => {
  const freezeFor = (r: ReturnType<typeof rig>, expiresInMs: number) =>
    r.db
      .prepare(`INSERT INTO system_settings (id, key, value) VALUES ('f1', ?, ?)`)
      .run(freezeKey('access'), JSON.stringify({ expiresAt: Date.now() + expiresInMs }));

  it('a WRITE is refused 503 retryable while frozen (marker or not), a READ before the marker is served by Postgres', async () => {
    const r = rig();
    r.store(S1, 's1');
    freezeFor(r, 60_000);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const pg = vi.fn(async () => 'pg');
    await expect(
      platformRouter.route('storeStaff', 'create', [{ data: {} }], pg)
    ).rejects.toMatchObject({ statusCode: 503, code: 'PLATFORM_FAMILY_FROZEN' });
    expect(pg).not.toHaveBeenCalled();
    expect(await platformRouter.route('storeStaff', 'findMany', [], pg)).toBe('pg');

    r.marker(); // marker + freeze: still refused until the script lifts it (no mixed backends)
    await expect(
      prisma.storeStaff.create({ data: { storeId: S1, userId: U1 } })
    ).rejects.toMatchObject({ code: 'PLATFORM_FAMILY_FROZEN' });
    r.db.prepare('DELETE FROM system_settings WHERE key = ?').run(freezeKey('access'));
    await prisma.storeStaff.create({ data: { storeId: S1, userId: U1 } });
    expect(r.seats(S1)).toBe(1);
  });

  it('an EXPIRED freeze is ignored and raises a P1 once', async () => {
    const r = rig();
    freezeFor(r, -1000);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const pg = vi.fn(async () => 'pg');
    expect(await platformRouter.route('staffInvite', 'create', [], pg)).toBe('pg');
    expect(await platformRouter.route('staffInvite', 'create', [], pg)).toBe('pg');
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendAlert).mock.calls[0][0]).toMatchObject({ level: 'p1' });
  });

  it('the access models are in the routed set (raw-tx clients route through them too)', () => {
    expect(platformRouter.models.has('storeStaff')).toBe(true);
    expect(platformRouter.models.has('staffInvite')).toBe(true);
  });
});

describe('review fixes', () => {
  it('checkStoreAccess on D1: owner ok, staff ok, removed staff denied, another store denied, unknown 404', async () => {
    const r = rig();
    r.store(S1, 's1');
    r.store(S2, 's2', { owner: 'owner-2' });
    r.staff(S1, U1);
    r.marker();
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    expect((await checkStoreAccess(S1, { userId: OWNER, role: 'store_admin' })).ok).toBe(true);
    expect((await checkStoreAccess(S1, { userId: U1, role: 'staff' })).ok).toBe(true);
    expect((await checkStoreAccess(S2, { userId: U1, role: 'staff' })).ok).toBe(false);
    expect((await checkStoreAccess(S2, { userId: OWNER, role: 'store_admin' })).ok).toBe(false);
    r.db.prepare('DELETE FROM store_staff WHERE user_id = ?').run(U1);
    expect(await checkStoreAccess(S1, { userId: U1, role: 'staff' })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await checkStoreAccess(crypto.randomUUID(), { userId: U1, role: 'staff' })
    ).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('removeStaffMember: membership + pending invites (by address and by user) go in one batch; other stores untouched', async () => {
    const r = rig();
    r.store(S1, 's1');
    r.store(S2, 's2');
    r.staff(S1, U1);
    r.staff(S2, U1);
    r.invite('p1', S1, 'A@x.test');
    r.invite('p2', S2, 'a@x.test');
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    expect(await removeStaffMember(S1, U1, 'a@x.test')).toBe(true);
    expect(r.seats(S1)).toBe(0);
    expect(r.seats(S2)).toBe(1);
    expect(r.inviteStatus('p1')).toBe('expired');
    expect(r.inviteStatus('p2')).toBe('pending');
    expect(await removeStaffMember(S1, U1, 'a@x.test')).toBe(false); // idempotent
  });

  it('removeStaffMember with no resolvable address still removes the membership atomically', async () => {
    const r = rig();
    r.store(S1, 's1');
    r.staff(S1, U1);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    expect(await removeStaffMember(S1, U1, null)).toBe(true);
    expect(r.seats(S1)).toBe(0);
  });

  it('eraseUserAccess frees the seats, revokes pending invites by address, scrubs actor columns; idempotent', async () => {
    const r = rig();
    r.store(S1, 's1');
    r.store(S2, 's2');
    r.staff(S1, U1);
    r.staff(S2, U1);
    r.staff(S1, U2);
    r.invite('p1', S1, 'gone@x.test');
    r.invite('by', S1, 'z@x.test');
    r.db
      .prepare(
        `UPDATE staff_invites SET invited_by = ?, status = 'accepted', accepted_by = ? WHERE id = 'by'`
      )
      .run(U1, U1);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    await eraseUserAccess(U1, 'Gone@x.test');
    expect(r.seats(S1)).toBe(1); // U2 stays
    expect(r.seats(S2)).toBe(0);
    expect(r.inviteStatus('p1')).toBe('revoked');
    const row = r.db
      .prepare(`SELECT invited_by, accepted_by FROM staff_invites WHERE id = 'by'`)
      .get() as Record<string, unknown>;
    expect(row).toEqual({ invited_by: null, accepted_by: null });
    await eraseUserAccess(U1, 'Gone@x.test'); // again: nothing left, no error
  });

  it('storeBriefsD1 lists live stores only', async () => {
    const r = rig();
    r.store(S1, 's1');
    r.store(S2, 's2');
    r.db.prepare('UPDATE stores SET deleted_at = ? WHERE id = ?').run(Date.now(), S2);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    expect((await storeBriefsD1([S1, S2])).map(x => x.id)).toEqual([S1]);
  });

  it('the copy script never asks Postgres for storage_backend (D1-only column) and lists the access tables', async () => {
    const src = fs.readFileSync(
      new URL('../../scripts/cf/cutover-platform-family.mjs', import.meta.url),
      'utf8'
    );
    const pgSql = /const STORE_FACTS_SQL_PG =\s*'([^']+)'/.exec(src)?.[1] ?? '';
    expect(pgSql).toContain('FROM stores');
    expect(pgSql).not.toContain('storage_backend');
    expect(src).toContain("access: ['store_staff', 'staff_invites']");
  });
});

describe('raw-transaction guard', () => {
  it('access models are only touched by the allow-listed files, never via a raw $transaction / withMoneyTx', async () => {
    const root = new URL('../../apps/api/src/', import.meta.url);
    const hits: string[] = [];
    const walk = (dir: URL) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
        if (e.isDirectory()) walk(u);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          if (/\.(storeStaff|staffInvite)\b/.test(fs.readFileSync(u, 'utf8')))
            hits.push(`apps/api/src/${u.href.slice(root.href.length)}`);
        }
      }
    };
    walk(root);
    hits.sort();
    const allowed = [
      'apps/api/src/lib/identity-directory.ts',
      'apps/api/src/lib/store-members.ts',
      'apps/api/src/mcp/merchant-auth.ts',
      'apps/api/src/middleware/store-access.ts',
      'apps/api/src/routes/admin.routes.ts',
      'apps/api/src/routes/staff-invite.routes.ts',
      'apps/api/src/routes/staff.routes.ts',
      'apps/api/src/services/page-builder.service.ts',
      'apps/api/src/services/plan-limit.service.ts',
      'apps/api/src/services/staff-invite.service.ts',
    ];
    // A new caller must be added here on purpose, and reviewed for: scope = prisma/withStore/inAccessScope (routed),
    // never `$transaction`, `withMoneyTx`, `scopeTransaction` or `withTenantContext` (their raw tx bypasses the router).
    expect(hits).toEqual(allowed);
    for (const f of hits) {
      const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(
        /(withMoneyTx|scopeTransaction|withTenantContext|\$transaction)\s*\(/g
      ))
        throw new Error(`${f}: ${m[1]} would bypass the access router`);
    }
  });
});
