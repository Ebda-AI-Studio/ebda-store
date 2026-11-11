import { AppError } from '../../middleware/error-handler';

/**
 * True when a per-store job step failed because the store is gone for good: its storage was removed (410
 * STORE_STORAGE_REMOVED, a `pg` directory row on Workers) or it no longer exists (404 STORE_NOT_FOUND). A retry can never
 * make it come back, so a loop over stores SKIPS it with a log and carries on; every other error (503 unreadable
 * directory, a real failure) still throws so it retries and alerts. Production 2026-11-11: `billing-renewal-daily`
 * failed whole on one closed store.
 */
export function isStoreGoneError(err: unknown): boolean {
  return err instanceof AppError && (err.statusCode === 410 || err.statusCode === 404);
}
