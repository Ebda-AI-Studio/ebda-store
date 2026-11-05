/**
 * Ruling CF-R2-REF-1: before the request-time cleanup deletes an R2 image it asks the Durable Object of every DO store whether it
 * still references it (the store's Postgres rows are sealed and stale). A reference on the DO keeps the object; a DO that cannot be
 * read keeps it too (a leaked file, never a deleted live one); a Postgres store is unaffected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stores: [] as string[],
  backends: {} as Record<string, 'do' | 'pg'>,
  // per DO store: table -> rows ({id, <column>: value})
  doRows: {} as Record<string, Record<string, Array<Record<string, string | null>>>>,
  doFails: new Set<string>(),
  pgReferenced: false,
  pages: [] as string[],
}));

vi.mock('@ebda/database', () => ({
  currentStoreId: () => {
    throw new Error('no ambient store');
  },
  prisma: {},
  storeDirectory: async () => h.stores.map(id => ({ id })),
  withStore: async (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $executeRaw: async () => 0,
      $queryRawUnsafe: async () => [{ referenced: h.pgReferenced }],
    }),
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeRepo: async (id: string) =>
    h.backends[id] === 'do'
      ? {
          backend: 'do',
          money: {
            r2References: async (a: {
              table: string;
              columns: string[];
              after?: string;
              limit: number;
            }) => {
              if (h.doFails.has(id)) throw new Error('DO unreachable');
              h.pages.push(`${id}:${a.table}`);
              const rows = (h.doRows[id]?.[a.table] ?? []).filter(
                r => (r.id ?? '') > (a.after ?? '')
              );
              return { missing: false, rows, last: null };
            },
          },
        }
      : { backend: 'pg', money: null },
}));
vi.mock('../../apps/api/src/services/storage.service', () => ({
  StorageService: { isAvailable: () => true, delete: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../apps/api/src/config', () => ({
  config: { storagePublicUrl: 'https://cdn.example.com', storageEndpoint: '', storageBucket: '' },
}));

import { deleteR2ObjectIfOrphan } from '../../apps/api/src/services/r2-cleanup.service';
import { StorageService } from '../../apps/api/src/services/storage.service';
import { R2_REFERENCE_COLUMNS } from '../../apps/api/src/lib/r2-references';

const URL_ = 'https://cdn.example.com/products/shared.jpg';
const imageCol = R2_REFERENCE_COLUMNS.find(c => c.table === 'product_images')!;

beforeEach(() => {
  vi.clearAllMocks();
  h.stores = ['pg-1', 'do-1'];
  h.backends = { 'pg-1': 'pg', 'do-1': 'do' };
  h.doRows = {};
  h.doFails.clear();
  h.pgReferenced = false;
  h.pages.length = 0;
});

describe('request-time R2 cleanup consults the DO of a DO store (Ruling CF-R2-REF-1)', () => {
  it('KEEPS the object when a DO store still references it', async () => {
    h.doRows['do-1'] = { [imageCol.table]: [{ id: 'i1', [imageCol.column]: URL_ }] };
    await deleteR2ObjectIfOrphan(URL_);
    expect(h.pages.some(p => p.startsWith('do-1:'))).toBe(true);
    expect(StorageService.delete).not.toHaveBeenCalled();
  });

  it('DELETES the object when neither Postgres nor any DO references it', async () => {
    h.doRows['do-1'] = {
      [imageCol.table]: [{ id: 'i1', [imageCol.column]: 'https://cdn.example.com/other.jpg' }],
    };
    await deleteR2ObjectIfOrphan(URL_);
    expect(StorageService.delete).toHaveBeenCalledWith('products/shared.jpg');
  });

  it('KEEPS the object when the DO cannot be read (fail-safe, no partial answer)', async () => {
    h.doFails.add('do-1');
    await deleteR2ObjectIfOrphan(URL_);
    expect(StorageService.delete).not.toHaveBeenCalled();
  });

  it('a Postgres-only reference still keeps the object and never calls a DO', async () => {
    h.pgReferenced = true;
    await deleteR2ObjectIfOrphan(URL_);
    expect(h.pages).toEqual([]);
    expect(StorageService.delete).not.toHaveBeenCalled();
  });

  it('a Postgres store is not read through a DO', async () => {
    h.stores = ['pg-1'];
    await deleteR2ObjectIfOrphan(URL_);
    expect(h.pages).toEqual([]);
    expect(StorageService.delete).toHaveBeenCalled();
  });
});
