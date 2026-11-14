/** Review finding 5 (#772): a deleted store's VAT change records (#774) do not outlive it. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@api/lib/store-directory-sync', () => ({ retireStoreDirectoryRow: vi.fn() }));
vi.mock('@api/lib/store-backend', () => ({ storeDo: vi.fn() }));
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('@api/services/storage.service', () => ({ StorageService: { deletePrivate: vi.fn() } }));

import { purgeTaxChangeRecords } from '@api/lib/tax-change-purge';
import { anonymiseDeletedStore } from '@api/lib/store-delete-post-commit';

describe('purgeTaxChangeRecords', () => {
  it('deletes the evidence object first, then both system_settings rows', async () => {
    const order: string[] = [];
    const r = await purgeTaxChangeRecords('s1', {
      readRow: async key =>
        key === 'tax.change.s1' ? { storageKey: 'private/tax/s1/doc.pdf' } : null,
      deleteObject: async k => void order.push(`obj:${k}`),
      deleteRows: async keys => void order.push(`rows:${keys.join(',')}`),
    });
    expect(order).toEqual([
      'obj:private/tax/s1/doc.pdf',
      'rows:tax.change.s1,tax.change-result.s1',
    ]);
    expect(r.object).toBe(true);
  });
  it('a store with no request still clears the result notice and touches no object', async () => {
    const deleteObject = vi.fn();
    const deleteRows = vi.fn(async () => undefined);
    await purgeTaxChangeRecords('s2', { readRow: async () => null, deleteObject, deleteRows });
    expect(deleteObject).not.toHaveBeenCalled();
    expect(deleteRows).toHaveBeenCalledWith(['tax.change.s2', 'tax.change-result.s2']);
  });
  it('a failed object delete throws BEFORE the rows go, so the retry can still find the key', async () => {
    const deleteRows = vi.fn();
    await expect(
      purgeTaxChangeRecords('s3', {
        readRow: async () => ({ storageKey: 'k' }),
        deleteObject: async () => {
          throw new Error('r2 down');
        },
        deleteRows,
      })
    ).rejects.toThrow('r2 down');
    expect(deleteRows).not.toHaveBeenCalled();
  });
});

describe('anonymiseDeletedStore runs the tax-change purge', () => {
  it('calls it, and a failure is retried, alerted and named without stopping other steps', async () => {
    const purgeTaxChange = vi.fn(async () => {
      throw new Error('x');
    });
    const eraseD1 = vi.fn(async () => undefined);
    const alert = vi.fn();
    const r = await anonymiseDeletedStore('s1', { purgeTaxChange, eraseD1, alert });
    expect(purgeTaxChange).toHaveBeenCalledTimes(3);
    expect(eraseD1).toHaveBeenCalledTimes(1);
    expect(r.failed).toEqual(['tax-change-records']);
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
