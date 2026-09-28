/**
 * #1830 — `POST /stores/:storeId/expenses/upload-receipt` answers a failed
 * upload as `{ error: 'no_file', message }` (a bare-string `error`, `message`
 * a sibling key). The reader used to read `body?.error?.message`, which is
 * always `undefined` for a string — silently discarding the operator-
 * actionable message and showing the generic "Upload failed (503)" instead.
 *
 * Mutation-proof: dropping the `body.message` fallback (restoring the old
 * `body?.error?.message` only) reddens "reads the message for THIS route's
 * actual bare-string-error shape".
 */
import { describe, it, expect } from 'vitest';
import { resolveUploadErrorMessage } from '../expense-upload-error';

describe('resolveUploadErrorMessage', () => {
  it("reads the message for the route's actual bare-string-error shape (the reported defect)", () => {
    expect(
      resolveUploadErrorMessage({
        error: 'storage_unavailable',
        message: 'R2 storage is not configured.',
      })
    ).toBe('R2 storage is not configured.');
    expect(resolveUploadErrorMessage({ error: 'no_file', message: 'No file uploaded.' })).toBe(
      'No file uploaded.'
    );
  });

  it('still reads the object envelope ({ error: { code, message } }) when a route uses that shape', () => {
    expect(
      resolveUploadErrorMessage({ error: { code: 'SOME_CODE', message: 'Nested message' } })
    ).toBe('Nested message');
  });

  it('prefers the object-envelope message over a sibling message when both are present', () => {
    expect(
      resolveUploadErrorMessage({
        error: { code: 'X', message: 'nested wins' },
        message: 'sibling loses',
      })
    ).toBe('nested wins');
  });

  it('returns undefined (so the caller falls back to its generic copy) for an empty or malformed body', () => {
    expect(resolveUploadErrorMessage({})).toBeUndefined();
    expect(resolveUploadErrorMessage(null)).toBeUndefined();
    expect(resolveUploadErrorMessage(undefined)).toBeUndefined();
    expect(resolveUploadErrorMessage('not an object')).toBeUndefined();
    expect(resolveUploadErrorMessage({ error: 'no_file' })).toBeUndefined();
  });
});
