/**
 * STORE-STANDING-1 (#839): a store's standing (suspended, live, deleted) reaches Ebda Chat on EVERY write of `stores.status` /
 * `deletedAt` and on every delete, so Chat stops every send that costs money. "May this store's messaging spend" is NEVER-stale:
 * a missed write path is a suspended store that keeps spending.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const h = vi.hoisted(() => ({ store: vi.fn(), linkRow: vi.fn(), send: vi.fn(), after: vi.fn() }));
const dbMock = vi.hoisted(() => ({ store: { findUnique: h.store } }));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@ebda/database')>();
  return {
    ...actual,
    prisma: dbMock,
    runInTenantContext: (_s: string, fn: () => unknown) => fn(),
    runInStoreScope: (_s: string, fn: () => unknown) => fn(),
    withStore: (_s: string, fn: (tx: unknown) => unknown) => fn(dbMock),
  };
});
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async (storeId: string) => ({ storeId, backend: 'pg', db: dbMock }),
}));
vi.mock('@api/lib/wa/link', () => ({ isWhatsAppLinked: vi.fn(), hasWhatsAppLinkRow: h.linkRow }));
vi.mock('@api/lib/inngest/send-after-commit', () => ({ sendEventAfterCommit: h.after }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { storeEventSchema } from '@api/contracts/wa-v1';
import { emitStoreEventsFor } from '@api/lib/inngest/functions/wa-store-events';
import {
  STANDING_CHANGED_EVENT,
  onStandingWrite,
  standingChangeStoreId,
  standingInput,
} from '@api/lib/wa/standing-state';

const S = '11111111-1111-4111-8111-111111111111';
const w = (model: string, operation: string, args: object, result: object = {}) => ({
  model,
  operation,
  args,
  result,
});
const row = (status: string, extra: Record<string, unknown> = {}) => ({
  status,
  deletedAt: null,
  billingSuspendedReason: null,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  setCfBindings({ WA_EVENTS_QUEUE: { send: h.send } } as never);
  return () => clearCfBindings();
});

describe('standingChangeStoreId: which writes change a store standing', () => {
  it.each([
    [
      'billing suspension (compare-and-set)',
      w('Store', 'updateMany', {
        where: { id: S, status: 'active' },
        data: { status: 'suspended', billingSuspendedReason: 'unpaid' },
      }),
    ],
    [
      'billing restore',
      w('Store', 'updateMany', {
        where: { id: S },
        data: { status: 'active', billingSuspendedReason: null },
      }),
    ],
    [
      'super admin status change',
      w('Store', 'update', { where: { id: S }, data: { status: 'suspended' } }),
    ],
    ['soft delete', w('Store', 'update', { where: { id: S }, data: { deletedAt: new Date() } })],
    ['hard delete', w('Store', 'delete', { where: { id: S } })],
  ])('%s -> the store', (_n, e) => expect(standingChangeStoreId(e)).toBe(S));

  it.each([
    ['a name change', w('Store', 'update', { where: { id: S }, data: { name: 'x' } })],
    ['another model', w('Product', 'update', { where: { id: S }, data: { status: 'archived' } })],
    ['a read', w('Store', 'findUnique', { where: { id: S } })],
  ])('%s -> nothing', (_n, e) => expect(standingChangeStoreId(e)).toBeNull());

  it('the observer asks the job (a delete says so: nothing is left to read)', () => {
    onStandingWrite(w('Store', 'delete', { where: { id: S } }));
    expect(h.after).toHaveBeenCalledWith(
      'wa-standing-changed',
      { name: STANDING_CHANGED_EVENT, data: { storeId: S, deleted: true } },
      { ifUnhookable: 'send' }
    );
  });
});

describe('standingInput: the CURRENT standing, stamped with the read time', () => {
  const now = new Date('2026-11-15T10:00:00Z');
  it.each([
    [
      'billing unpaid',
      row('suspended', { billingSuspendedReason: 'unpaid' }),
      { type: 'store.suspended', data: { reason: 'unpaid', at: now.toISOString() } },
    ],
    [
      'over the store limit',
      row('suspended', { billingSuspendedReason: 'over_store_limit' }),
      { type: 'store.suspended', data: { reason: 'over_store_limit', at: now.toISOString() } },
    ],
    [
      'a super admin suspension',
      row('suspended'),
      { type: 'store.suspended', data: { reason: 'admin', at: now.toISOString() } },
    ],
    ['live', row('active'), { type: 'store.reactivated', data: { at: now.toISOString() } }],
    [
      'paused by its merchant',
      row('inactive'),
      { type: 'store.reactivated', data: { at: now.toISOString() } },
    ],
    [
      'soft-deleted',
      row('active', { deletedAt: now }),
      { type: 'store.deleted', data: { at: now.toISOString() } },
    ],
    ['gone', null, { type: 'store.deleted', data: { at: now.toISOString() } }],
  ])('%s', async (_n, r, expected) => {
    h.store.mockResolvedValue(r);
    const p = await standingInput(S, { now });
    expect(p.input).toMatchObject({ storeId: S, ...expected });
  });

  it('every read is its own envelope: suspend -> reactivate -> suspend is never swallowed by the consumer dedupe', async () => {
    h.store.mockResolvedValue(row('suspended', { billingSuspendedReason: 'unpaid' }));
    const a = await standingInput(S, { now: new Date(1_000) });
    const b = await standingInput(S, { now: new Date(2_000) });
    expect(a.seed).not.toBe(b.seed);
  });

  it('an unreadable store is never reported as deleted (the job retries)', async () => {
    h.store.mockRejectedValue(new Error('d1 down'));
    await expect(standingInput(S)).rejects.toThrow('d1 down');
  });
});

describe('emitStoreEventsFor(store/standing-changed)', () => {
  it('a suspended store Ebda Chat knows gets store.suspended on the queue, a valid v1.6 envelope', async () => {
    h.linkRow.mockResolvedValue(true);
    h.store.mockResolvedValue(row('suspended', { billingSuspendedReason: 'unpaid' }));
    expect(
      await emitStoreEventsFor({ name: STANDING_CHANGED_EVENT, data: { storeId: S } } as never)
    ).toBe(1);
    const sent = h.send.mock.calls[0]![0];
    expect(storeEventSchema.parse(sent)).toMatchObject({
      type: 'store.suspended',
      storeId: S,
      data: { reason: 'unpaid' },
    });
  });

  it('a store Ebda Chat never knew (no link row) gets nothing', async () => {
    h.linkRow.mockResolvedValue(false);
    h.store.mockResolvedValue(row('suspended'));
    expect(
      await emitStoreEventsFor({ name: STANDING_CHANGED_EVENT, data: { storeId: S } } as never)
    ).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a deleted store is always announced (its link row went with it)', async () => {
    h.linkRow.mockResolvedValue(false);
    expect(
      await emitStoreEventsFor({
        name: STANDING_CHANGED_EVENT,
        data: { storeId: S, deleted: true },
      } as never)
    ).toBe(1);
    expect(h.store).not.toHaveBeenCalled();
    expect(storeEventSchema.parse(h.send.mock.calls[0]![0]).type).toBe('store.deleted');
  });
});

describe('every standing write path announces (source guard: a path that forgets is a suspended store that keeps spending)', () => {
  const src = (p: string) => readFileSync(path.resolve(__dirname, '../../apps/api/src', p), 'utf8');
  it('the one database observer installs the standing observer', () => {
    expect(src('lib/wa/observers.ts')).toMatch(/onStandingWrite\(e\)/);
  });
  it('billing suspend / restore announce through afterStatusChange (a DO store write may not pass the observer)', () => {
    const body = src('services/billing/account.service.ts')
      .split('async function afterStatusChange')[1]!
      .split('\n}\n')[0]!;
    expect(body).toMatch(/notifyStandingChanged\(storeId\)/);
  });
  it('a store delete announces store.deleted after it committed', () => {
    const body = src('services/store.service.ts').split('static async delete(')[1]!;
    expect(body).toMatch(/notifyStandingChanged\(storeId, \{ deleted: true \}\)/);
  });
  it('the 12-hourly reconcile re-sends the standing of every linked store', () => {
    const sync = src('lib/inngest/functions/wa-store-events.ts').split(
      'export const waPlanSync'
    )[1]!;
    expect(sync).toMatch(/name: STANDING_CHANGED_EVENT/);
  });
});
