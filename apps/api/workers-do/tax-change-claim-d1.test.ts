import { beforeAll, describe, expect, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { createD1Client } from '@ebda-src/repo';
import meta from '@ebda-src/prisma-meta';
import { setCfBindings, type CfBindings } from '../src/cf/bindings';
import { claimPendingChangeD1 } from '../src/services/tax-change-claim';

// VAT change request (self-service A10) on the REAL platform D1: the two primitives the service relies on, with the exact
// shapes it sends. (1) `system_settings.key` is unique, so of two concurrent creates exactly one wins (the atomic step of
// requestTaxChange). (2) A claim is `deleteMany({ key, value: { path: ['id'], equals: requestId } })`: of two concurrent claims
// exactly one removes the row, and a claim for another request id (withdraw + resubmit in between) removes nothing.
const e = env as unknown as { PLATFORM_DB: D1Database; TEST_PLATFORM_MIGRATIONS: unknown[] };
type Setting = {
  create(a: unknown): Promise<unknown>;
  deleteMany(a: unknown): Promise<{ count: number }>;
  findUnique(a: unknown): Promise<{ value: { id: string } } | null>;
};
let settings: Setting;
let n = 0;
const keyFor = () => `tax.change.d1-claim-${++n}`;
const row = (key: string, id: string) => ({
  data: {
    key,
    value: { id, taxRegistrationNumber: '123456789' },
    category: 'tax',
    isPublic: false,
  },
});

describe('tax change request claim on real D1', () => {
  beforeAll(async () => {
    await applyD1Migrations(e.PLATFORM_DB, e.TEST_PLATFORM_MIGRATIONS as never);
    // the platform family is on D1 (the marker the Worker reads), so onD1('platform') is true as in production
    await e.PLATFORM_DB.prepare(
      "INSERT OR REPLACE INTO system_settings (id, key, value) VALUES ('m-platform', 'platform_cutover.platform', '{\"on\":true}')"
    ).run();
    setCfBindings(e as unknown as CfBindings);
    settings = (
      createD1Client(meta as never, e.PLATFORM_DB as never) as unknown as { systemSetting: Setting }
    ).systemSetting;
  });

  it('two concurrent creates of the same key: exactly one wins', async () => {
    const key = keyFor();
    const out = await Promise.allSettled([
      settings.create(row(key, 'req-a')),
      settings.create(row(key, 'req-b')),
    ]);
    expect(out.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(out.filter(o => o.status === 'rejected')).toHaveLength(1);
  });

  it('claimPendingChangeD1: of two concurrent claims exactly one wins (the lite deleteMany reports 1 for BOTH, measured)', async () => {
    const key = keyFor();
    await settings.create(row(key, 'req-1'));
    const out = await Promise.all([
      claimPendingChangeD1(key, 'req-1'),
      claimPendingChangeD1(key, 'req-1'),
    ]);
    expect(out.filter(v => v === true)).toHaveLength(1);
    expect(await settings.findUnique({ where: { key } })).toBeNull();
  });

  // Deterministic withdraw -> resubmit interleaving: a decision read request `req-old`, then the merchant withdrew and resubmitted
  // (`req-new` now holds the key); the late claim for `req-old` must remove nothing. Fails without the id match in the SQL.
  it('a claim for another request id removes nothing and leaves the newer request', async () => {
    const key = keyFor();
    await settings.create(row(key, 'req-old'));
    await settings.deleteMany({ where: { key } }); // withdrawn
    await settings.create(row(key, 'req-new')); // resubmitted
    expect(await claimPendingChangeD1(key, 'req-old')).toBe(false);
    expect((await settings.findUnique({ where: { key } }))?.value.id).toBe('req-new');
  });
});
