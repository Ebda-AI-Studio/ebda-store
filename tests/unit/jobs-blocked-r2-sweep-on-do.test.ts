/**
 * Ruling CF-JOBS-4B: r2-orphan-sweep with a store on its Durable Object. The sweep deletes objects, so it may only call an object
 * an orphan once EVERY store's references were read: a DO store's images are read from its DO (`r2References`), and any failure to
 * read them ends the run before a single delete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const old = new Date(Date.now() - 10 * 86_400_000);
const h = vi.hoisted(() => ({
  bucket: [] as string[],
  deleted: [] as string[],
  doRows: {} as Record<string, Array<Record<string, string | null>>>,
  doFails: false,
  doMissing: false,
  alerts: [] as unknown[],
  d1Bound: false,
  pgCalls: [] as string[],
}));
vi.mock('@api/config', () => ({
  config: {
    storageEndpoint: 'e',
    storageAccessKey: 'k',
    storageSecretKey: 's',
    storageBucket: 'b',
  },
}));
vi.mock('@api/lib/lazy-modules', () => ({
  loadS3: async () => ({
    ListObjectsV2Command: class {
      constructor(public i: unknown) {}
    },
    DeleteObjectsCommand: class {
      constructor(public i: { Delete: { Objects: Array<{ Key: string }> } }) {}
    },
    S3Client: class {
      async send(cmd: { i?: any; constructor: { name: string } }) {
        if (cmd.constructor.name === 'DeleteObjectsCommand')
          h.deleted.push(...cmd.i.Delete.Objects.map((o: { Key: string }) => o.Key));
        else
          return {
            Contents: h.bucket.map(Key => ({ Key, Size: 10, LastModified: old })),
            IsTruncated: false,
          };
        return {};
      }
    },
  }),
}));
vi.mock('@ebda/database', async () => ({
  prisma: {},
  isOwnerRole: async () => {
    h.pgCalls.push('isOwnerRole');
    return !h.d1Bound;
  },
  withOwnerTx: async (fn: (tx: unknown) => unknown) => {
    h.pgCalls.push('withOwnerTx');
    return fn({ $queryRawUnsafe: async () => [] });
  },
  storeDirectory: async () => [{ id: DO_STORE }],
  withoutHiddenStores: <T>(fn: () => T) => fn(),
}));
vi.mock('@api/lib/r2-references', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/r2-references')>()),
  assertStrictTablesVisible: async () => {
    h.pgCalls.push('assertStrictTablesVisible');
  },
}));
vi.mock('@api/lib/platform-directory', () => ({ platformDb: () => (h.d1Bound ? {} : undefined) }));
vi.mock('@api/lib/r2-platform-d1-references', () => ({
  platformD1ReferencedKeys: async () => new Set<string>(),
}));
vi.mock('@api/services/r2-cleanup.service', () => ({
  urlToR2Key: (u: string) => (u.startsWith('https://r2/') ? u.slice('https://r2/'.length) : null),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({
    backend: 'do',
    money: {
      r2References: async (a: { table: string; columns: string[] }) => {
        if (h.doFails) throw new Error('DO unreachable');
        if (h.doMissing) return { missing: true, rows: [], last: null };
        return { missing: false, rows: h.doRows[a.table] ?? [], last: null };
      },
    },
  }),
}));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: (a: unknown) => (h.alerts.push(a), Promise.resolve('sent')),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: (options: unknown, handler: unknown) => ({ options, handler }) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { r2OrphanSweep } from '@api/lib/inngest/functions/r2-orphan-sweep';
import { PORTED_JOBS } from '@api/lib/jobs/job-data';
import { decideRunForStore } from '@api/lib/jobs/do-guard';

const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> =>
    JSON.parse(JSON.stringify(await fn())),
};
const run = () =>
  (r2OrphanSweep as unknown as { handler: (a: unknown) => Promise<any> }).handler({ step });

beforeEach(() => {
  h.bucket = ['stores/x/product-live.jpg', 'stores/x/page-live.jpg', 'stores/x/orphan.jpg'];
  h.deleted.length = 0;
  h.alerts.length = 0;
  h.doFails = false;
  h.doMissing = false;
  h.d1Bound = false;
  h.pgCalls.length = 0;
  h.doRows = {
    product_images: [{ id: 'i1', url: 'https://r2/stores/x/product-live.jpg' }],
    store_pages: [
      { id: 'p1', content_blocks: '{"blocks":[{"img":"https://r2/stores/x/page-live.jpg"}]}' },
    ],
  };
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
  vi.stubEnv('R2_ORPHAN_SWEEP_APPLY', 'true');
});

describe('r2-orphan-sweep with a DO store', () => {
  it('is ported and not refused', async () => {
    expect(PORTED_JOBS.has('r2-orphan-sweep')).toBe(true);
    expect(await decideRunForStore({ id: 'r2-orphan-sweep' } as never, DO_STORE)).toEqual({
      run: true,
    });
  });

  it('keeps what the DO store references (url and json columns) and deletes only the real orphan; a second run deletes nothing', async () => {
    h.bucket = ['stores/x/product-live.jpg', 'stores/x/page-live.jpg', 'stores/x/orphan.jpg'];
    const first = await run();
    expect(first).toMatchObject({ orphanCount: 1, deleted: 1 });
    expect(h.deleted).toEqual(['stores/x/orphan.jpg']);
    h.bucket = h.bucket.filter(k => !h.deleted.includes(k));
    h.deleted.length = 0;
    expect(await run()).toMatchObject({ orphanCount: 0, deleted: 0 });
    expect(h.deleted).toEqual([]);
  });

  it('a DO store whose references cannot be read ends the run before any delete', async () => {
    h.doFails = true;
    await expect(run()).rejects.toThrow(/DO unreachable/);
    expect(h.deleted).toEqual([]);
  });

  it('a registry table the DO schema lacks also ends the run before any delete', async () => {
    h.doMissing = true;
    await expect(run()).rejects.toThrow(/has no /);
    expect(h.deleted).toEqual([]);
  });

  it('Ruling NZ-PG-2: with the platform D1 bound Postgres is never touched (no owner-role check, no reference scan, no visibility assertion) and the DO references still decide', async () => {
    h.d1Bound = true;
    const out = await run();
    expect(out).toMatchObject({ orphanCount: 1, deleted: 1 });
    expect(h.deleted).toEqual(['stores/x/orphan.jpg']);
    expect(h.pgCalls).toEqual([]);
  });
});
