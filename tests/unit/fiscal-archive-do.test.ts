/**
 * Ruling FISCAL-ARCHIVE-1: a DO store's deletion exports its fiscal records to the platform archive FIRST and FAILS CLOSED.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@api/lib/store-backend', () => ({ storeDo: vi.fn() }));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => undefined }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));

import { archiveDoStoreFiscal, billingLine } from '@api/lib/fiscal-archive-do';
import { FISCAL_ARCHIVE_PREFIX, type FiscalExportSource } from '@api/lib/fiscal-archive-store';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const failing: FiscalExportSource = {
  page: async () => {
    throw new Error('do down');
  },
  billing: async () => [],
  storeName: async () => null,
};

describe('archiveDoStoreFiscal', () => {
  it('on failure: raises a P1 alert naming the store, throws 503 FISCAL_ARCHIVE_FAILED, never reports success', async () => {
    const alert = vi.fn();
    await expect(
      archiveDoStoreFiscal('s-1', {
        source: failing,
        r2: { put: vi.fn(), get: async () => null, list: vi.fn() } as never,
        alert,
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_ARCHIVE_FAILED' });
    expect(alert).toHaveBeenCalledOnce();
    expect(String(alert.mock.calls[0][1])).toContain('s-1');
  });

  it('a missing bucket binding also fails closed (never a silent skip)', async () => {
    const alert = vi.fn();
    await expect(
      archiveDoStoreFiscal('s-2', {
        source: { ...failing, page: async () => ({ rows: [], next: null }) },
        alert,
      })
    ).rejects.toMatchObject({ code: 'FISCAL_ARCHIVE_FAILED' });
    expect(alert).toHaveBeenCalled();
  });
});

describe('billingLine (Ebda subscription VAT ledger row)', () => {
  it('maps to a billing record with net = gross - VAT and retention = issue + 7y, carrying no payer data', () => {
    const created = Date.UTC(2026, 0, 5);
    const l = billingLine({
      id: 'b1',
      created_at: created,
      currency: 'EGP',
      amount_minor: 11400,
      vat_minor: 1400,
      vat: JSON.stringify({ rateBps: 1400, trn: '123' }),
      type: 'charge',
      status: 'paid',
      provider: 'paymob',
    });
    expect(l).toMatchObject({
      net_amount: 10000,
      vat_amount: 1400,
      total_amount: 11400,
      vat_rate_bps: 1400,
    });
    expect(new Date(l.retain_until as number).getUTCFullYear()).toBe(2033);
  });
});

describe('wiring', () => {
  it('store.service exports BEFORE any delete and before the directory row is retired, inside the compensating-rollback try', () => {
    const s = read('apps/api/src/services/store.service.ts');
    const call = s.indexOf('await archiveDoStoreFiscal(storeId)');
    const tryStart = s.lastIndexOf('try {', call);
    expect(call).toBeGreaterThan(s.indexOf('closeDoIfNoMoney(storeId)'));
    expect(tryStart).toBeGreaterThan(s.indexOf('closeDoIfNoMoney(storeId)'));
    expect(call).toBeLessThan(s.indexOf('withMoneyTx(prisma'));
    expect(call).toBeLessThan(s.indexOf('await finishStoreDeletion('));
    // the catch reopens the DO this delete closed
    expect(s.indexOf('reopenDoAfterFailedDelete(storeId, doClose.token)')).toBeGreaterThan(call);
  });

  it('the archive prefix is outside every purge/expiry prefix and no erasure code deletes it', () => {
    for (const p of ['stores/', 'exports/', 'store-do-backups/', 'outcomes/'])
      expect(FISCAL_ARCHIVE_PREFIX.startsWith(p)).toBe(false);
    for (const f of [
      'apps/api/src/cf/erasure/surfaces.ts',
      'apps/api/src/cf/erasure/job.ts',
      'apps/api/src/services/storage.service.ts',
      'apps/api/src/lib/store-delete-post-commit.ts',
    ])
      expect(read(f)).not.toContain('fiscal-archive');
    expect(read('scripts/ops/cf-logs-setup.sh')).not.toContain('fiscal-archive');
  });
});
