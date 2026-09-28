/**
 * #1830 — `POST /stores/:storeId/expenses/upload-receipt` answers a failed
 * upload as `{ error: 'no_file', message }` / `{ error: 'storage_unavailable',
 * message }`: `error` is a bare STRING with `message` as a SIBLING key, not
 * the `{ error: { code, message } }` object envelope most of the platform
 * uses. The expenses "new" page read `body?.error?.message`, which is always
 * `undefined` for a string `error` — silently discarding an
 * operator-actionable message like "R2 storage is not configured." and
 * showing the generic "Upload failed (503)" instead.
 *
 * This route's response shape is intentionally left alone (see Ruling
 * P2-B8-1 in docs/RULINGS.md — several other admin routes share the same
 * flat-string convention and are self-consistent with their own readers);
 * only the reader is fixed, and only for this one route.
 */
export function resolveUploadErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { error?: unknown; message?: unknown };
  if (b.error && typeof b.error === 'object') {
    const nested = (b.error as { message?: unknown }).message;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  if (typeof b.message === 'string' && b.message.length > 0) return b.message;
  return undefined;
}
