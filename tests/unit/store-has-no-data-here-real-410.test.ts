/**
 * Production 2026-11-11 04:31Z: `search-log-purge-daily` failed again for qa-merchant-test
 * (3f2bf043-..., STORE_STORAGE_REMOVED) although `storeHasNoDataHere` was meant to skip it. On a Worker the REAL
 * `backendFor` throws 410 for a `pg` row, so the guard never reached its comparison; the old sweep test mocked
 * `backendFor` to return 'pg' and could not see it. This test makes `backendFor` behave like production.
 */
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@api/middleware/error-handler';

const h = vi.hoisted(() => ({ removed: true, backendFor: vi.fn() }));
vi.mock('@api/lib/postgres-present', () => ({ postgresRemovedOnThisWorker: () => h.removed }));
vi.mock('@api/lib/store-backend', () => ({ backendFor: h.backendFor }));

import { storeHasNoDataHere } from '@api/lib/store-pg-gone';

describe('storeHasNoDataHere with the real Worker backendFor', () => {
  it('is true when backendFor answers 410 STORE_STORAGE_REMOVED', async () => {
    h.backendFor.mockRejectedValue(
      new AppError(410, 'STORE_STORAGE_REMOVED', 'This store is no longer available')
    );
    await expect(storeHasNoDataHere('3f2bf043')).resolves.toBe(true);
  });
  it('is true on 404, false for a DO store, and rethrows a 503', async () => {
    h.backendFor.mockRejectedValueOnce(new AppError(404, 'STORE_NOT_FOUND', 'Store not found'));
    await expect(storeHasNoDataHere('x')).resolves.toBe(true);
    h.backendFor.mockResolvedValueOnce('do');
    await expect(storeHasNoDataHere('x')).resolves.toBe(false);
    h.backendFor.mockRejectedValueOnce(new AppError(503, 'UNAVAILABLE', 'down'));
    await expect(storeHasNoDataHere('x')).rejects.toThrow('down');
  });
});
