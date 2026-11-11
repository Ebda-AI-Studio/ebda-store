import { describe, it, expect, vi } from 'vitest';

vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@api/lib/store-directory-sync', () => ({ retireStoreDirectoryRow: vi.fn() }));
vi.mock('@api/lib/store-backend', () => ({ storeDo: vi.fn() }));

import { anonymiseDeletedStore } from '@api/lib/store-delete-post-commit';
import { purgeStoreVectorsWith } from '@api/lib/search/purge-store-vectors';
import { vectorizeSurface } from '@api/cf/erasure/surfaces';

describe('P2-7: vectors die with the store', () => {
  it('anonymiseDeletedStore purges the store vectors', async () => {
    const purgeVectors = vi.fn(async () => 3);
    const r = await anonymiseDeletedStore('s1', { purgeVectors, alert: vi.fn() });
    expect(purgeVectors).toHaveBeenCalledWith('s1');
    expect(r.failed).toEqual([]);
  });

  it('a Vectorize failure is retried, alerted, named in failed, and does not stop the other steps', async () => {
    const purgeVectors = vi.fn(async () => {
      throw new Error('vectorize down');
    });
    const eraseD1 = vi.fn(async () => undefined);
    const alert = vi.fn();
    const r = await anonymiseDeletedStore('s1', { purgeVectors, eraseD1, alert });
    expect(purgeVectors).toHaveBeenCalledTimes(3);
    expect(eraseD1).toHaveBeenCalledTimes(1);
    expect(r.failed).toEqual(['vectorize']);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0]![1])).toContain('vectorize');
  });

  it('deletes <id>:d and <id>:w for every product, across pages, and is idempotent', async () => {
    const all = Array.from({ length: 450 }, (_, i) => `p${String(i).padStart(4, '0')}`);
    const deleteByIds = vi.fn(async () => undefined);
    const deps = {
      index: { deleteByIds } as never,
      listProductIds: async (_s: string, after: string, limit: number) =>
        all.filter(id => id > after).slice(0, limit),
    };
    expect(await purgeStoreVectorsWith('s1', deps)).toBe(450);
    const ids = deleteByIds.mock.calls.flatMap(c => c[0] as unknown as string[]);
    expect(ids).toHaveLength(900);
    expect(ids).toContain('p0449:d');
    expect(ids).toContain('p0000:w');
    expect(await purgeStoreVectorsWith('s1', deps)).toBe(450); // a retry converges
  });

  it('no Vectorize binding = nothing to delete; a Vectorize error propagates', async () => {
    const list = vi.fn(async () => ['a']);
    expect(await purgeStoreVectorsWith('s1', { index: null, listProductIds: list })).toBe(0);
    expect(list).not.toHaveBeenCalled();
    await expect(
      purgeStoreVectorsWith('s1', {
        index: {
          deleteByIds: async () => {
            throw new Error('boom');
          },
        } as never,
        listProductIds: list,
      })
    ).rejects.toThrow('boom');
  });

  it('the closure erasure surface purges a merchant store and ignores customers', async () => {
    const purge = vi.fn(async () => 2);
    const s = vectorizeSurface(purge);
    const m = await s.eraseSubject({
      kind: 'merchant',
      requestId: 'r',
      storeId: 's1',
      ownerUserId: 'u',
    } as never);
    expect(purge).toHaveBeenCalledWith('s1');
    expect(m).toMatchObject({ erased: 2, remaining: 0 });
    await s.eraseSubject({ kind: 'customer', requestId: 'r', buyerKey: 'b' } as never);
    expect(purge).toHaveBeenCalledTimes(1);
  });
});
