/**
 * Ruling NEON-ZERO-2: PaymentConfig (encrypted provider credentials) and the StoreTaxProfile / StoreTaxDocument VAT gate live in
 * the store's Durable Object. In process: the real DO schema on SQLite, the real prisma-lite client. `@ebda/database`'s `prisma`
 * THROWS on any use, so a read or write that slipped to Postgres fails the test.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ audit: [] as unknown[], putPrivate: 0 }));

vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  const boom = (what: string) => () => {
    throw new Error(`Postgres touched: ${what}`);
  };
  return {
    ...real,
    prisma: new Proxy({}, { get: (_t, p) => boom(`prisma.${String(p)}`)() }),
    runInTenantContext: boom('runInTenantContext'),
    withStore: async (_s: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    withUser: async (_u: string, fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('@api/middleware/security', () => ({
  auditLog: async (e: unknown) => void h.audit.push(e),
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: {
    putPrivate: async () => ({ key: `tax/${++h.putPrivate}.pdf` }),
    getPrivate: async () => ({ body: Buffer.from('%PDF-1.4') }),
    deletePrivate: async () => undefined,
  },
}));
vi.mock('@api/services/store.service', () => ({ bustStoreCachesById: async () => undefined }));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: async (_n: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { storeDb, storeWriter, withRepo } from '@api/lib/repo-factory';
import { TaxProfileService } from '@api/services/tax-profile.service';
import { loadCodFeeConfig } from '@api/services/payment-providers/cod.provider';
import { InstapayService } from '@api/services/payment-providers/instapay.service';
import { META, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

const STORE = '19b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const ADMIN = '29b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const sqlite = openSqlite();
let repo: { storeId: string; backend: 'do'; db: never; writer: never };
/** The role the API Worker would stamp on a write (from the verified token); the DO review guard reads it. */
let role: string | undefined = 'store_admin';
let afterFirstProfileRead: (() => void) | null = null;
const on = <T>(f: () => Promise<T>) => withRepo(repo as never, f);
const rows = (sql: string, ...p: unknown[]) => sqlite.prepare(sql).all(...(p as never[])) as any[];

beforeAll(() => {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, { ...m, actorRole: role })
  ) as never;
  const db = new Proxy(c as object, {
    get(t, p) {
      const v = (t as Record<string | symbol, unknown>)[p];
      if (p !== 'storeTaxProfile') return v;
      return new Proxy(v as object, {
        get(tt, pp) {
          const f = (tt as Record<string | symbol, unknown>)[pp] as (...a: unknown[]) => unknown;
          if (pp !== 'findUnique' || !afterFirstProfileRead) return f;
          return async (...a: unknown[]) => {
            const out = await f.apply(tt, a);
            const hook = afterFirstProfileRead;
            afterFirstProfileRead = null;
            hook?.(); // the race window between the service's read and its write
            return out;
          };
        },
      });
    },
  });
  repo = { storeId: STORE, backend: 'do', db: db as never, writer: c };
});
beforeEach(() => {
  role = 'store_admin';
  afterFirstProfileRead = null;
  h.audit.length = 0;
  sqlite.exec(
    'DELETE FROM payment_configs; DELETE FROM store_tax_documents; DELETE FROM store_tax_profiles'
  );
});

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)]);

describe('payment config on the DO', () => {
  it('stores ciphertext untouched, reads it back, and enforces one row per (store, provider)', async () => {
    await on(async () => {
      const w = await storeWriter(STORE);
      const created = await w.paymentConfig.create({
        data: {
          storeId: STORE,
          provider: 'paymob',
          isEnabled: false,
          apiKey: 'enc:v1:CIPHERTEXT',
          apiKeyLast4: 'abcd',
          testMode: true,
          supportedMethods: ['card'],
          supportedCurrencies: ['EGP'],
          settings: { a: 1 },
        },
      });
      expect(created.apiKey).toBe('enc:v1:CIPHERTEXT');
      const got = await (
        await storeDb(STORE)
      ).paymentConfig.findFirst({
        where: { storeId: STORE, provider: 'paymob' },
      });
      expect(got).toMatchObject({
        apiKey: 'enc:v1:CIPHERTEXT',
        settings: { a: 1 },
        testMode: true,
      });
      await expect(
        w.paymentConfig.create({ data: { storeId: STORE, provider: 'paymob', isEnabled: false } })
      ).rejects.toBeTruthy();
    });
    expect(rows('SELECT api_key FROM payment_configs')).toEqual([{ api_key: 'enc:v1:CIPHERTEXT' }]);
  });

  it('unset-other-default + create is one atomic batch (a failing create leaves the old default)', async () => {
    await on(async () => {
      const w = await storeWriter(STORE);
      await w.paymentConfig.create({
        data: { storeId: STORE, provider: 'tap', isEnabled: true, isDefault: true },
      });
      await expect(
        w.$transaction([
          w.paymentConfig.updateMany({
            where: { storeId: STORE, isDefault: true },
            data: { isDefault: false },
          }),
          // duplicate (store, provider): the whole batch rolls back
          w.paymentConfig.create({
            data: { storeId: STORE, provider: 'tap', isEnabled: true, isDefault: true },
          }),
        ])
      ).rejects.toBeTruthy();
      expect(
        await (
          await storeDb(STORE)
        ).paymentConfig.count({
          where: { storeId: STORE, isDefault: true },
        })
      ).toBe(1);
      // the no-op form used when the new row is not a default
      const r = await w.paymentConfig.updateMany({
        where: { storeId: STORE, id: { in: [] } },
        data: { isDefault: false },
      });
      expect(r.count).toBe(0);
    });
  });

  it('checkout readers (COD fee, InstaPay config) answer from the DO', async () => {
    await on(async () => {
      const w = await storeWriter(STORE);
      await w.paymentConfig.create({
        data: {
          storeId: STORE,
          provider: 'cod',
          isEnabled: true,
          fixedFee: 500,
          settings: { percentBps: 100 },
        },
      });
      await w.paymentConfig.create({
        data: {
          storeId: STORE,
          provider: 'instapay',
          isEnabled: true,
          settings: { handle: 'shop@instapay' },
        },
      });
      expect(await loadCodFeeConfig(STORE)).toEqual({ fixedFee: 500, percentBps: 100 });
      expect((await InstapayService.getConfig(STORE))?.provider).toBe('instapay');
    });
  });
});

describe('tax profile on the DO', () => {
  it('details -> document -> submit -> approve -> VAT collected; every write in the DO', async () => {
    await on(async () => {
      const actor = { userId: ADMIN };
      expect(await TaxProfileService.get(STORE)).toMatchObject({ status: 'none' });
      const v = await TaxProfileService.updateDetails(
        STORE,
        { taxRegistrationNumber: '123456789', legalName: 'Acme LLC' },
        actor
      );
      expect(v.taxRegistrationNumber).toBe('123456789');
      await TaxProfileService.addDocument(
        STORE,
        'tax_card' as never,
        { buffer: PDF, originalname: 'card.pdf' },
        actor
      );
      const pending = await TaxProfileService.submit(STORE, actor);
      expect(pending.status).toBe('pending');
      expect(pending.documents).toHaveLength(1);
      role = 'super_admin';
      const done = await TaxProfileService.review(STORE, { decision: 'approve' } as never, actor);
      expect(done.status).toBe('verified');
      expect(await TaxProfileService.isVerified(STORE)).toBe(true);
      const doc = pending.documents[0]!;
      expect((await TaxProfileService.readDocument(STORE, doc.id)).mimeType).toBe(
        'application/pdf'
      );
    });
    expect(rows('SELECT status FROM store_tax_profiles')).toEqual([{ status: 'verified' }]);
    expect(rows('SELECT count(*) n FROM store_tax_documents')[0].n).toBe(1);
  });

  it('two first requests racing create ONE profile', async () => {
    await on(async () => {
      const actor = { userId: ADMIN };
      await Promise.all(
        [1, 2, 3, 4].map(() =>
          TaxProfileService.updateDetails(
            STORE,
            { taxRegistrationNumber: '987654321', legalName: 'Race Co' },
            actor
          )
        )
      );
    });
    expect(rows('SELECT count(*) n FROM store_tax_profiles')[0].n).toBe(1);
  });

  it('a pending profile cannot be edited, and approve of a non-pending one is refused', async () => {
    await on(async () => {
      const actor = { userId: ADMIN };
      await TaxProfileService.updateDetails(
        STORE,
        { taxRegistrationNumber: '123456789', legalName: 'Acme LLC' },
        actor
      );
      role = 'super_admin';
      await expect(
        TaxProfileService.review(STORE, { decision: 'approve' } as never, actor)
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
      role = 'store_admin';
      await TaxProfileService.addDocument(
        STORE,
        'tax_card' as never,
        { buffer: PDF, originalname: 'c.pdf' },
        actor
      );
      await TaxProfileService.submit(STORE, actor);
      await expect(
        TaxProfileService.updateDetails(
          STORE,
          { taxRegistrationNumber: '1', legalName: 'x' },
          actor
        )
      ).rejects.toBeTruthy();
    });
  });
});

describe('tax profile review guard on the DO (the Postgres trigger, reproduced)', () => {
  const seed = (status: string) =>
    sqlite.exec(
      `INSERT INTO store_tax_profiles (id, store_id, status, tax_registration_number, legal_name, updated_at) VALUES ('tp1', '${STORE}', '${status}', '123456789', 'Acme LLC', 0)`
    );
  const status = () => rows('SELECT status, tax_registration_number t FROM store_tax_profiles')[0];

  it('a merchant cannot move a profile into verified / rejected / revoked, whatever the write shape', async () => {
    seed('pending');
    await on(async () => {
      const w = await storeWriter(STORE);
      for (const to of ['verified', 'rejected', 'revoked'])
        await expect(
          w.storeTaxProfile.update({ where: { storeId: STORE }, data: { status: to as never } })
        ).rejects.toThrow(/only a super_admin/);
      await expect(
        w.storeTaxProfile.updateMany({ where: { storeId: STORE }, data: { status: 'verified' } })
      ).rejects.toThrow(/only a super_admin/);
      // an unauthenticated / job caller (no role) is no better
      role = undefined;
      await expect(
        w.storeTaxProfile.updateMany({ where: { storeId: STORE }, data: { status: 'verified' } })
      ).rejects.toThrow(/only a super_admin/);
      role = 'super_admin';
      await w.storeTaxProfile.update({ where: { storeId: STORE }, data: { status: 'verified' } });
    });
    expect(status()).toMatchObject({ status: 'verified' });
  });

  it('a verified identity is changed only by a super_admin', async () => {
    seed('verified');
    await on(async () => {
      const w = await storeWriter(STORE);
      await expect(
        w.storeTaxProfile.updateMany({
          where: { storeId: STORE },
          data: { taxRegistrationNumber: '999999999' },
        })
      ).rejects.toThrow(/verified identity/);
      expect(status()).toMatchObject({ t: '123456789' });
      role = 'super_admin';
      await w.storeTaxProfile.updateMany({
        where: { storeId: STORE },
        data: { taxRegistrationNumber: '999999999' },
      });
    });
    expect(status()).toMatchObject({ t: '999999999' });
  });

  it('evidence of a pending profile cannot be added or removed by a merchant', async () => {
    seed('pending');
    const doc = (id: string) => ({
      data: {
        id,
        storeId: STORE,
        profileId: 'tp1',
        kind: 'tax_card' as never,
        storageKey: `k/${id}`,
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 5,
        sha256: 'x',
      },
    });
    await on(async () => {
      const w = await storeWriter(STORE);
      await expect(w.storeTaxDocument.create(doc('d1') as never)).rejects.toThrow(/evidence/);
      expect(rows('SELECT count(*) n FROM store_tax_documents')[0].n).toBe(0);
      role = 'super_admin';
      await w.storeTaxDocument.create(doc('d2') as never);
      role = 'store_admin';
      await expect(w.storeTaxDocument.delete({ where: { id: 'd2' } })).rejects.toThrow(/evidence/);
    });
    expect(rows('SELECT count(*) n FROM store_tax_documents')[0].n).toBe(1);
  });

  it('TOCTOU: an admin moving the profile to pending between the merchant read and write is not overwritten', async () => {
    seed('rejected');
    await on(async () => {
      afterFirstProfileRead = () =>
        sqlite.exec("UPDATE store_tax_profiles SET status = 'pending' WHERE id = 'tp1'");
      await expect(
        TaxProfileService.updateDetails(
          STORE,
          { taxRegistrationNumber: '555555555', legalName: 'Late Edit' },
          { userId: ADMIN }
        )
      ).rejects.toMatchObject({ code: 'TAX_PROFILE_LOCKED' });
    });
    expect(status()).toMatchObject({ status: 'pending', t: '123456789' });
  });

  it('TOCTOU: two reviewers cannot both move one pending profile', async () => {
    seed('pending');
    role = 'super_admin';
    await on(async () => {
      const results = await Promise.allSettled([
        TaxProfileService.review(STORE, { decision: 'approve' } as never, { userId: ADMIN }),
        TaxProfileService.review(STORE, { decision: 'reject', reason: 'no' } as never, {
          userId: ADMIN,
        }),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    });
  });
});
