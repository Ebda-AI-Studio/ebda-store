/**
 * NEON-ZERO-1 N-10d: the `payments` and `ops` families on D1, the family order guard, the audit sink (where a row goes, retry,
 * dead letter, impersonatedBy), the audit D1 mapping of the copy script and the R2 reference scan over D1.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const alerts = vi.hoisted(() => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('../../apps/api/src/services/alerts.service', () => alerts);

const repo = vi.hoisted(() => ({
  doStores: new Set<string>(),
  created: [] as Array<{ storeId: string; data: Record<string, unknown> }>,
  failNext: 0,
  dupNext: false,
  unreachable: new Set<string>(),
  procs: [] as Array<{ id: string; name: string; args: Record<string, unknown> }>,
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeWritesToDo: async (id: string) => repo.doStores.has(id),
  storeRepo: async () => ({
    backend: 'do',
    db: { auditLog: { findMany: async () => [], count: async () => 0 } },
  }),
  storeWriter: async (id: string) => ({
    $proc: async (name: string, args: Record<string, unknown>) => {
      if (repo.unreachable.has(id)) throw new Error('do down');
      repo.procs.push({ id, name, args });
      return 2;
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (repo.failNext > 0) {
          repo.failNext--;
          throw new Error('do unavailable');
        }
        if (repo.dupNext) throw Object.assign(new Error('dup'), { code: 'P2002' });
        repo.created.push({ storeId: id, data });
        return data;
      },
    },
  }),
}));

import { prisma } from '@ebda/database';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import {
  cutoverKey,
  freezeKey,
  resetCutoverCache,
} from '../../apps/api/src/services/platform/cutover';
import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';
import {
  appendAudit,
  applyAuditRetry,
  auditTargets,
  isAuditWriteRetry,
  parkDeadAuditRow,
  type AuditRow,
} from '../../apps/api/src/services/audit-sink';
import { platformD1ReferencedKeys } from '../../apps/api/src/lib/r2-platform-d1-references';

const MIG = ['0001_init.sql', '0002_invariants.sql', '0003_late_columns.sql']
  .map(f =>
    fs.readFileSync(
      new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
      'utf8'
    )
  )
  .join('\n');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

type Family = 'billing' | 'payments' | 'ops' | 'audit';
function world(markers: Family[], extra: Record<string, unknown> = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIG);
  const stmt = (sql: string, v: unknown[]) =>
    /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
      ? { results: db.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } }
      : { results: [], meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) } };
  const d1 = {
    prepare: (sql: string) => ({
      all: async () => (await Promise.resolve(), stmt(sql, [])),
      bind: (...v: unknown[]) => ({
        all: async () => (await Promise.resolve(), stmt(sql, v)),
        run: async () => (await Promise.resolve(), stmt(sql, v)),
        first: async () => (await Promise.resolve(), (stmt(sql, v).results[0] ?? null) as never),
      }),
    }),
  };
  for (const [id, slug] of [
    [A, 'a'],
    [B, 'b'],
  ])
    db.prepare(`INSERT INTO stores (id, name, slug, owner_id) VALUES (?, ?, ?, 'o')`).run(
      id,
      slug,
      slug
    );
  for (const m of markers)
    db.prepare(`INSERT INTO system_settings (id, key, value) VALUES (?, ?, '{}')`).run(
      `c-${m}`,
      cutoverKey(m)
    );
  setCfBindings({ PLATFORM_DB: d1, ...extra } as never);
  return db;
}

beforeEach(() => {
  resetCutoverCache();
  clearCfBindings();
  registerPlatformRouter();
  alerts.sendAlert.mockClear();
  repo.doStores.clear();
  repo.created.length = 0;
  repo.failNext = 0;
  repo.dupNext = false;
  repo.unreachable.clear();
  repo.procs.length = 0;
});

const claim = (storeId: string, ref: string) => ({
  storeId,
  planCode: 'growth',
  billingInterval: 'monthly',
  amountMinor: 49900,
  method: 'instapay',
  paymentReference: 'EBDA-1',
  payerReference: ref,
});

describe('payments family (money)', () => {
  it('claims and receipts are served by D1 once both markers exist; the transfer reference stays unique', async () => {
    const db = world(['billing', 'payments']);
    const c = await prisma.manualPaymentClaim.create({ data: claim(A, '12345678') });
    expect(db.prepare('SELECT COUNT(*) n FROM manual_payment_claims').get()).toEqual({ n: 1 });
    await expect(
      prisma.manualPaymentClaim.create({ data: claim(B, '12345678') })
    ).rejects.toMatchObject({
      code: 'P2002',
    });
    const upd = await prisma.manualPaymentClaim.updateMany({
      where: { id: c.id, storeId: A, status: 'pending' },
      data: { status: 'confirmed', reviewedBy: 'admin' },
    });
    expect(upd.count).toBe(1);
    // a second confirm finds nothing pending: the compare-and-set is the idempotency
    expect(
      (
        await prisma.manualPaymentClaim.updateMany({
          where: { id: c.id, storeId: A, status: 'pending' },
          data: { status: 'confirmed' },
        })
      ).count
    ).toBe(0);
    const r = await prisma.instapayReceipt.create({
      data: {
        storeId: A,
        kind: 'subscription',
        storageKey: 'k',
        mimeType: 'image/png',
        sizeBytes: 10,
        sha256: 'abc',
        claimId: c.id,
      },
    });
    expect(await prisma.instapayReceipt.findUnique({ where: { id: r.id } })).toMatchObject({
      claimId: c.id,
      status: 'draft',
    });
    const withStore = await prisma.manualPaymentClaim.findMany({
      where: { storeId: A },
      include: { store: { select: { name: true, slug: true, status: true } } },
    });
    expect(withStore[0].store).toMatchObject({ slug: 'a' });
  });

  it('refuses to serve claims from D1 while billing is still on Postgres (split money flow)', async () => {
    world(['payments']);
    await expect(
      prisma.manualPaymentClaim.findMany({ where: { storeId: A } })
    ).rejects.toMatchObject({ code: 'PLATFORM_FAMILY_ORDER', statusCode: 503 });
  });

  it('a write is refused (retryable) while the payments family is frozen', async () => {
    const db = world(['billing']);
    db.prepare(`INSERT INTO system_settings (id, key, value) VALUES ('f', ?, ?)`).run(
      freezeKey('payments'),
      JSON.stringify({ expiresAt: Date.now() + 60_000 })
    );
    await expect(
      prisma.manualPaymentClaim.create({ data: claim(A, '87654321') })
    ).rejects.toMatchObject({
      code: 'PLATFORM_FAMILY_FROZEN',
    });
  });
});

describe('ops family', () => {
  it('usage snapshots, CI insights and answer-engine keys are served by D1', async () => {
    const db = world(['ops']);
    const periodStart = new Date('2026-10-01T00:00:00Z');
    const snap = {
      where: { storeId_periodStart: { storeId: A, periodStart } },
      create: { storeId: A, periodStart, orders: 3, revenueFils: 12_345_678_901n },
      update: { orders: 4 },
    };
    await prisma.storeUsageSnapshot.upsert(snap);
    await prisma.storeUsageSnapshot.upsert(snap);
    expect(db.prepare('SELECT COUNT(*) n, MAX(orders) o FROM store_usage_snapshots').get()).toEqual(
      {
        n: 1,
        o: 4,
      }
    );
    const ins = {
      dedupeKey: 'k1',
      metric: 'return_rate',
      cohort: 'c',
      finding: 'f',
      findingAr: 'ف',
      evidence: { n: 40 },
      asOf: new Date('2026-10-30'),
    };
    await prisma.ciInsight.create({ data: ins });
    await expect(prisma.ciInsight.create({ data: ins })).rejects.toMatchObject({ code: 'P2002' });
    expect((await prisma.ciInsight.findMany({ where: { status: 'new' } }))[0].evidence).toEqual({
      n: 40,
    });
    await prisma.answerEngineProviderConfig.upsert({
      where: { engine: 'openai' },
      create: { engine: 'openai', apiKey: 'enc', enabled: true },
      update: { enabled: false },
    });
    expect((await prisma.answerEngineProviderConfig.findMany())[0]).toMatchObject({
      engine: 'openai',
    });
  });
});

const entry = (over: Partial<AuditRow> = {}) => ({
  action: 'store.updated',
  userId: 'u1',
  resourceType: 'store',
  resourceId: A,
  details: { x: 1 },
  ip: '1.1.1.1',
  userAgent: 'ua',
  ...over,
});
const pg = vi.fn(async (_row: AuditRow) => undefined);
const jobs = () => {
  const sent: unknown[] = [];
  return { sent, q: { send: vi.fn(async (m: unknown) => void sent.push(m)) } };
};

describe('audit sink', () => {
  beforeEach(() => pg.mockClear());

  it('store-less before the marker: Postgres, exactly as before', async () => {
    world([]);
    await appendAudit(entry({ storeId: undefined }), pg);
    expect(pg).toHaveBeenCalledTimes(1);
    expect(pg.mock.calls[0][0].id).toMatch(/[0-9a-f-]{36}/);
  });

  it('store-less after the marker, and while the redirect freeze is up: D1, with impersonatedBy in meta', async () => {
    const db = world(['audit']);
    await appendAudit(
      entry({ storeId: undefined, details: { impersonatedBy: 'root', k: 'v' } }),
      pg
    );
    expect(pg).not.toHaveBeenCalled();
    const row = db.prepare('SELECT * FROM platform_audit_log').get() as Record<string, string>;
    expect(row).toMatchObject({ actor_id: 'u1', action: 'store.updated', target_type: 'store' });
    expect(JSON.parse(row.meta)).toEqual({
      details: { impersonatedBy: 'root', k: 'v' },
      ipAddress: '1.1.1.1',
      userAgent: 'ua',
    });

    // freeze without marker: also D1 (a redirect, never a refusal)
    resetCutoverCache();
    const db2 = world([]);
    db2
      .prepare(`INSERT INTO system_settings (id, key, value) VALUES ('f', ?, ?)`)
      .run(freezeKey('audit'), JSON.stringify({ expiresAt: Date.now() + 60_000 }));
    await appendAudit(entry({ storeId: undefined }), pg);
    expect(pg).not.toHaveBeenCalled();
    expect(db2.prepare('SELECT COUNT(*) n FROM platform_audit_log').get()).toEqual({ n: 1 });
  });

  it('a DO store gets the row in its StoreDO; an impersonated one is mirrored to D1 as well', async () => {
    const db = world([]);
    repo.doStores.add(A);
    await appendAudit(entry({ storeId: A }), pg);
    expect(repo.created).toHaveLength(1);
    expect(repo.created[0].storeId).toBe(A);
    expect(repo.created[0].data).toMatchObject({
      storeId: A,
      action: 'store.updated',
      userId: 'u1',
    });
    expect(db.prepare('SELECT COUNT(*) n FROM platform_audit_log').get()).toEqual({ n: 0 });

    await appendAudit(entry({ storeId: A, details: { impersonatedBy: 'root' } }), pg);
    expect(repo.created).toHaveLength(2);
    expect(repo.created[1].data.details).toEqual({ impersonatedBy: 'root' });
    expect(db.prepare('SELECT store_id, meta FROM platform_audit_log').get()).toMatchObject({
      store_id: A,
    });
    expect(pg).not.toHaveBeenCalled();
  });

  it('a Postgres store keeps the definer leg', async () => {
    world([]);
    await appendAudit(entry({ storeId: B }), pg);
    expect(pg).toHaveBeenCalledTimes(1);
  });

  it('a failed DO write never throws into the caller: the WHOLE row is queued for retry', async () => {
    const { sent, q } = jobs();
    world([], { JOBS_QUEUE: q });
    repo.doStores.add(A);
    repo.failNext = 1;
    await expect(appendAudit(entry({ storeId: A }), pg)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(isAuditWriteRetry(sent[0])).toBe(true);
    const msg = sent[0] as { row: AuditRow };
    expect(msg.row).toMatchObject({ action: 'store.updated', storeId: A, details: { x: 1 } });
    // the retry delivers the same id, and a second delivery of that id (late original) is a no-op
    expect(await applyAuditRetry(sent[0] as never, { pgInsert: pg })).toBe('done');
    expect(repo.created[0].data.id).toBe(msg.row.id);
    repo.dupNext = true;
    expect(await applyAuditRetry(sent[0] as never, { pgInsert: pg })).toBe('done');
    expect(repo.created).toHaveLength(1);
  });

  it('retry reports "retry" while the home is still down', async () => {
    world([]);
    repo.doStores.add(A);
    repo.failNext = 1;
    const row: AuditRow = { ...entry({ storeId: A }), id: 'x1', createdAt: 1 };
    expect(await applyAuditRetry({ kind: 'audit-write-retry', row }, { pgInsert: pg })).toBe(
      'retry'
    );
  });

  it('no queue binding: the row is logged whole and a P1 pages (never silent)', async () => {
    world([]);
    repo.doStores.add(A);
    repo.failNext = 1;
    await appendAudit(entry({ storeId: A }), pg);
    expect(alerts.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'audit.write_at_risk' })
    );
  });

  it('dead letter: parked in R2 and a P1 pages', async () => {
    const put = vi.fn(async () => undefined);
    world([], { STORE_BACKUPS: { put } });
    const row: AuditRow = { ...entry({ storeId: A }), id: 'dead1', createdAt: 1 };
    await parkDeadAuditRow(row);
    expect(put).toHaveBeenCalledWith(
      'audit-dead-letter/dead1.json',
      expect.stringContaining('dead1')
    );
    expect(alerts.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'audit.retry_exhausted' })
    );
  });

  it('target resolution', async () => {
    world(['audit']);
    repo.doStores.add(A);
    const base = { ...entry(), id: 'i', createdAt: 1 };
    expect(await auditTargets({ ...base, storeId: undefined })).toEqual(['d1']);
    expect(await auditTargets({ ...base, storeId: A })).toEqual(['do']);
    expect(await auditTargets({ ...base, storeId: B })).toEqual(['pg']);
  });
});

describe('copy script: audit mapping and family list', () => {
  it('maps a Postgres audit row to the D1 platform_audit_log shape, keeping details (impersonatedBy) intact', async () => {
    const { auditRowToD1, FAMILIES } =
      (await import('../../scripts/cf/cutover-platform-family.mjs')) as {
        auditRowToD1: (r: Record<string, unknown>) => unknown[];
        FAMILIES: Record<string, string[]>;
      };
    expect(FAMILIES.audit).toEqual([]);
    const out = auditRowToD1({
      id: 'i1',
      user_id: 'u',
      action: 'a',
      resource_type: 'store',
      resource_id: 'r',
      details: { impersonatedBy: 'root' },
      ip_address: '9.9.9.9',
      user_agent: null,
      created_ms: '1700000000000',
    });
    expect(out.slice(0, 6)).toEqual(['i1', 'u', 'a', 'store', 'r', null]);
    expect(JSON.parse(out[6] as string)).toEqual({
      details: { impersonatedBy: 'root' },
      ipAddress: '9.9.9.9',
      userAgent: null,
    });
    expect(out[7]).toBe(1700000000000);
  });
});

describe('R2 references over D1', () => {
  it('a claim proof that only the D1 row names is seen as referenced; nothing before the marker', async () => {
    const toKey = (u: string) => (u.startsWith('https://cdn/') ? u.slice(12) : null);
    const db = world(['billing']);
    db.prepare(`PRAGMA foreign_keys = OFF`).run();
    db.prepare(
      `INSERT INTO manual_payment_claims (id, store_id, plan_code, billing_interval, amount_minor, method, payment_reference, payer_reference, proof_url)
       VALUES ('c1', ?, 'g', 'monthly', 1, 'instapay', 'e', 'r1', 'https://cdn/stores/a/proof.png')`
    ).run(A);
    expect((await platformD1ReferencedKeys(toKey)).size).toBe(0);
    resetCutoverCache();
    db.prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c-p', ?, '{}')`).run(
      cutoverKey('payments')
    );
    expect(
      (await platformD1ReferencedKeys(toKey, 'stores/a/proof.png')).has('stores/a/proof.png')
    ).toBe(true);
  });
});

describe('security review fixes', () => {
  it('a super-admin viewing a DO store audit trail is itself audited, with the store in details', async () => {
    const db = world(['audit']);
    repo.doStores.add(A);
    const { platformAuditLogs } = await import('../../apps/api/src/lib/definer');
    await platformAuditLogs.list({ actorUserId: 'root', storeId: A, limit: 10, offset: 0 });
    const row = db
      .prepare(
        `SELECT actor_id, meta FROM platform_audit_log WHERE action = 'audit.platform_viewed'`
      )
      .get() as { actor_id: string; meta: string };
    expect(row.actor_id).toBe('root');
    expect(JSON.parse(row.meta).details.storeId).toBe(A);
  });

  it('user erasure also unlinks the user in every DO store, and fails loudly when one is unreachable', async () => {
    const db = world(['audit']);
    db.prepare(`UPDATE stores SET storage_backend = 'do'`).run();
    const { unlinkUserAuditLogs } = await import('../../apps/api/src/lib/definer');
    const fake = { $queryRaw: async () => [{ n: 1 }] } as never;
    const total = await unlinkUserAuditLogs('u9', fake);
    expect(repo.procs.map(p => p.name)).toEqual(['auditUnlinkUser', 'auditUnlinkUser']);
    expect(total).toBe(1 + 0 + 4);
    repo.unreachable.add(B);
    await expect(unlinkUserAuditLogs('u9', fake)).rejects.toThrow(/not reached/);
  });

  it('a row that cannot be written or queued is never logged whole', async () => {
    const logger = (await import('../../apps/api/src/lib/logger')).default;
    const spy = vi.spyOn(logger, 'error');
    world([]);
    repo.doStores.add(A);
    repo.failNext = 1;
    await appendAudit(entry({ storeId: A, ip: '203.0.113.7', userAgent: 'SECRET-UA' }), pg);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/203\.0\.113\.7|SECRET-UA/);
    spy.mockRestore();
  });
});

describe('audit re-import into DO stores (copy script)', () => {
  it('sends every Postgres row of each DO store, verifies present = sent per store, refuses on a short count', async () => {
    const { reimportDoStoreAudit, auditRowToDoImport } =
      (await import('../../scripts/cf/cutover-platform-family.mjs')) as {
        reimportDoStoreAudit: (
          ...a: unknown[]
        ) => Promise<Array<{ storeId: string; pg: number; inserted: number }>>;
        auditRowToDoImport: (r: Record<string, unknown>) => Record<string, unknown>;
      };
    const rows = (n: number, store: string) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${store}-${String(i).padStart(4, '0')}`,
        user_id: null,
        action: 'a',
        store_id: store,
        resource_type: 't',
        resource_id: null,
        details: { k: i },
        ip_address: null,
        user_agent: null,
        created_ms: '1790000000000',
      }));
    const all = [...rows(3, 's1'), ...rows(501, 's2')];
    const client = {
      query: async (_sql: string, [store, after, limit]: [string, string, number]) => ({
        rows: all.filter(r => r.store_id === store && r.id > after).slice(0, limit),
      }),
    };
    const seen: Array<{ url: string; n: number }> = [];
    const mk = (short?: string) => async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { rows: unknown[] };
      seen.push({ url, n: body.rows.length });
      const present = url.includes(short ?? '#') ? body.rows.length - 1 : body.rows.length;
      return { ok: true, status: 200, json: async () => ({ ok: true, inserted: 1, present }) };
    };
    const args = { doUrl: 'https://do', secret: 'x'.repeat(30) };
    const out = await reimportDoStoreAudit(client, args, ['s1', 's2'], mk() as never);
    expect(out.map(o => [o.storeId, o.pg])).toEqual([
      ['s1', 3],
      ['s2', 501],
    ]);
    expect(seen.filter(s => s.url.includes('/s2/')).map(s => s.n)).toEqual([500, 1]);
    expect(seen[0].url).toBe('https://do/cutover/stores/s1/__auditimport');
    await expect(reimportDoStoreAudit(client, args, ['s1'], mk('s1') as never)).rejects.toThrow(
      /holds 2 of 3/
    );
    expect(auditRowToDoImport(all[0]).details).toBe('{"k":0}');
  });
});

describe('payments reconcile (receipts without claim, claims against the ledger)', () => {
  const old = new Date(Date.now() - 60 * 60_000);
  const receipt = (over: Record<string, unknown> = {}) => ({
    storeId: A,
    kind: 'subscription',
    storageKey: 'k',
    mimeType: 'image/png',
    sizeBytes: 10,
    sha256: 'h',
    status: 'submitted',
    submittedAt: old,
    referenceKey: '11112222',
    ...over,
  });
  async function run() {
    const { reconcilePayments } =
      await import('../../apps/api/src/services/billing/payments-reconcile.service');
    return reconcilePayments();
  }

  it('links a receipt to the pending claim that already holds its reference', async () => {
    const db = world(['billing', 'payments']);
    const c = await prisma.manualPaymentClaim.create({
      data: { ...claim(A, '11112222'), updatedAt: old },
    });
    const r = await prisma.instapayReceipt.create({ data: receipt() as never });
    expect(await run()).toMatchObject({ linked: 1, rolledBack: 0, undecided: [] });
    expect(db.prepare('SELECT claim_id FROM instapay_receipts WHERE id = ?').get(r.id)).toEqual({
      claim_id: c.id,
    });
  });

  it('rolls back a receipt with no claim to draft; a second run changes nothing', async () => {
    const db = world(['billing', 'payments']);
    const r = await prisma.instapayReceipt.create({ data: receipt() as never });
    expect(await run()).toMatchObject({ rolledBack: 1 });
    expect(
      db
        .prepare('SELECT status, reference_key, submitted_at FROM instapay_receipts WHERE id = ?')
        .get(r.id)
    ).toEqual({ status: 'draft', reference_key: null, submitted_at: null });
    expect(await run()).toMatchObject({ linked: 0, rolledBack: 0, confirmed: 0 });
  });

  it('leaves a young receipt alone', async () => {
    const db = world(['billing', 'payments']);
    await prisma.instapayReceipt.create({ data: receipt({ submittedAt: new Date() }) as never });
    expect(await run()).toMatchObject({ rolledBack: 0 });
    expect(db.prepare(`SELECT status FROM instapay_receipts`).get()).toEqual({
      status: 'submitted',
    });
  });

  it('confirms a pending claim whose payment is already in the ledger and approves its receipt', async () => {
    const db = world(['billing', 'payments']);
    const { manualPaymentKey } =
      await import('../../apps/api/src/services/billing/account.service');
    const c = await prisma.manualPaymentClaim.create({
      data: { ...claim(A, '33334444'), updatedAt: old },
    });
    await prisma.instapayReceipt.create({
      data: receipt({ claimId: c.id, referenceKey: '33334444' }) as never,
    });
    await prisma.billingEvent.create({
      data: {
        storeId: A,
        type: 'manual_payment',
        planCode: 'growth',
        billingInterval: 'monthly',
        amountMinor: 49900,
        currency: 'EGP',
        provider: 'manual',
        providerRef: '33334444',
        idempotencyKey: manualPaymentKey('instapay', '33334444'),
        status: 'succeeded',
      } as never,
    });
    expect(await run()).toMatchObject({ confirmed: 1, undecided: [] });
    expect(
      db.prepare('SELECT status, billing_event_id FROM manual_payment_claims').get()
    ).toMatchObject({
      status: 'confirmed',
    });
    expect(db.prepare('SELECT status FROM instapay_receipts').get()).toEqual({
      status: 'approved',
    });
  });

  it('pages P1 for a confirmed claim with no ledger event and touches nothing', async () => {
    const db = world(['billing', 'payments']);
    await prisma.manualPaymentClaim.create({
      data: { ...claim(A, '55556666'), status: 'confirmed', updatedAt: old },
    });
    const out = await run();
    expect(out.undecided[0]).toMatch(/confirmed without a matching ledger event/);
    expect(alerts.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'payments.reconcile.undecided' })
    );
    expect(db.prepare('SELECT status FROM manual_payment_claims').get()).toEqual({
      status: 'confirmed',
    });
  });
});

describe('N-27 merchant erasure of payer PII in the platform payments tables', () => {
  const seed = async () => {
    const db = world(['billing', 'payments']);
    const c = await prisma.manualPaymentClaim.create({
      data: { ...claim(A, '77778888'), reviewedBy: 'admin1' },
    });
    await prisma.manualPaymentClaim.create({
      data: { ...claim(A, '99990000'), reviewedBy: 'admin1' },
    });
    await prisma.manualPaymentClaim.create({ data: claim(B, 'keep-b') });
    await prisma.instapayReceipt.create({
      data: {
        storeId: A,
        kind: 'subscription',
        storageKey: 'k',
        mimeType: 'image/png',
        sizeBytes: 10,
        sha256: 'h',
        status: 'approved',
        claimId: c.id,
        amountMinor: 49900,
        reference: '77778888',
        referenceKey: '77778888',
        payerName: 'Ali',
        payerAddress: 'ali@instapay',
        payerMobile: '01000000000',
        payerBank: 'CIB',
        receiverName: 'Ebda',
        reviewedBy: 'admin1',
        extractionStatus: 'done',
        extracted: { name: 'Ali' },
      } as never,
    });
    return db;
  };
  const surfaceFor = async () => {
    const { paymentsSurface } = await import('../../apps/api/src/cf/erasure/surfaces');
    const { paymentsErasurePort } =
      await import('../../apps/api/src/services/billing/payments-erasure');
    return paymentsSurface(paymentsErasurePort, async () => [A]);
  };
  const subject = { kind: 'merchant', requestId: 'req1', storeId: A, ownerUserId: 'o' } as never;

  it('anonymises payer values, keeps amounts and references, verifies remaining = 0, and is idempotent', async () => {
    const db = await seed();
    const surface = await surfaceFor();
    const out = await surface.eraseSubject(subject);
    expect(out).toMatchObject({ surface: 'platform-payments', remaining: 0 });
    expect(out.erased).toBeGreaterThan(0);
    expect(db.prepare('SELECT * FROM instapay_receipts').get()).toMatchObject({
      payer_name: null,
      payer_address: null,
      payer_mobile: null,
      payer_bank: null,
      receiver_name: null,
      reviewed_by: null,
      extracted: null,
      amount_minor: 49900,
      reference_key: '77778888',
    });
    const claims = db
      .prepare(
        `SELECT payer_reference, reviewed_by, amount_minor, store_id FROM manual_payment_claims ORDER BY store_id, payer_reference`
      )
      .all() as Array<Record<string, unknown>>;
    expect(
      claims
        .filter(c => c.store_id === A)
        .every(
          c =>
            String(c.payer_reference).startsWith('erased:req1:') &&
            c.reviewed_by === null &&
            c.amount_minor === 49900
        )
    ).toBe(true);
    expect(claims.find(c => c.store_id === B)?.payer_reference).toBe('keep-b'); // another store untouched
    const again = await surface.eraseSubject(subject);
    expect(again).toMatchObject({ erased: 0, remaining: 0 });
  });

  it('does not run when the store-do money gate refuses (job order), so nothing is anonymised', async () => {
    const db = await seed();
    const { runErasure } = await import('../../apps/api/src/cf/erasure/job');
    const paid = await surfaceFor();
    const gate = {
      name: 'store-do',
      exportSubject: async () => ({ surface: 'store-do', ndjson: '', records: 0 }),
      eraseSubject: async () => ({
        surface: 'store-do',
        erased: 0,
        remaining: 2,
        note: 'refused: money in flight',
      }),
    };
    const store = new Map<string, string>();
    const env = {
      PDPL_CF_ERASURE_ENABLED: 'true',
      STORE_BACKUPS: {
        get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
        put: async (k: string, v: string) => void store.set(k, v),
      },
    };
    const entry = await runErasure(env as never, [paid, gate as never], subject);
    expect(entry.status).toBe('failed');
    expect(entry.surfaces.map(s => s.surface)).toEqual(['store-do']);
    expect(db.prepare('SELECT payer_name FROM instapay_receipts').get()).toEqual({
      payer_name: 'Ali',
    });
  });
});
