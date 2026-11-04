/** NEON-ZERO N-17 (Ruling NZ-D23): on a Worker a directory row that still says `pg` is a clean 410, never a Prisma call. */
import { describe, it, expect, vi } from 'vitest';

const row = (r: unknown) => ({ prepare: () => ({ bind: () => ({ first: async () => r }) }) });

async function load(workers: boolean) {
  vi.resetModules();
  vi.doMock('../../apps/api/src/lib/runtime', () => ({ isWorkers: workers }));
  const bindings = await import('../../apps/api/src/cf/bindings');
  const mod = await import('../../apps/api/src/lib/store-backend');
  return { ...mod, ...bindings };
}

describe('backendFor on a Worker with a pg directory row', () => {
  it('answers 410 STORE_STORAGE_REMOVED on Workers', async () => {
    const { backendFor, setCfBindings } = await load(true);
    setCfBindings({ PLATFORM_DB: row({ storage_backend: 'pg' }) } as never);
    await expect(backendFor('s1')).rejects.toMatchObject({ statusCode: 410 });
  });
  it('a do row still resolves, and Node keeps the pg value (tests / dev)', async () => {
    const w = await load(true);
    w.setCfBindings({ PLATFORM_DB: row({ storage_backend: 'do' }) } as never);
    await expect(w.backendFor('s1')).resolves.toBe('do');
    const n = await load(false);
    n.setCfBindings({ PLATFORM_DB: row({ storage_backend: 'pg' }) } as never);
    await expect(n.backendFor('s1')).resolves.toBe('pg');
  });
});
