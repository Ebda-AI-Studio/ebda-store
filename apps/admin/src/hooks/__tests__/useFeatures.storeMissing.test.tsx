// @vitest-environment jsdom
/** QA-91: a store id the user cannot open is "store missing", not an empty shell and not a retryable outage. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'store_admin' } }) }));

import { AdminFeatureProvider, useFeatures } from '../useFeatures';

function Probe() {
  const { isLoading, loadFailed, storeMissing } = useFeatures();
  return (
    <p data-testid="s">
      {isLoading ? 'loading' : storeMissing ? 'missing' : loadFailed ? 'failed' : 'ok'}
    </p>
  );
}
const run = async (error: { status: number; code?: string }) => {
  api.apiGet.mockResolvedValueOnce({ data: null, error });
  render(
    <AdminFeatureProvider storeId="00000000-0000-0000-0000-000000000000">
      <Probe />
    </AdminFeatureProvider>
  );
  await waitFor(() => expect(screen.getByTestId('s').textContent).not.toBe('loading'));
  return screen.getByTestId('s').textContent;
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AdminFeatureProvider storeMissing', () => {
  it('404 STORE_NOT_FOUND => missing', async () => {
    expect(await run({ status: 404, code: 'STORE_NOT_FOUND' })).toBe('missing');
  });
  it('403 FORBIDDEN (not your store) => missing', async () => {
    expect(await run({ status: 403, code: 'FORBIDDEN' })).toBe('missing');
  });
  it('a 500 stays a retryable outage, never "missing"', async () => {
    expect(await run({ status: 500 })).toBe('failed');
  });
  it('a plan 403 is not "missing"', async () => {
    expect(await run({ status: 403, code: 'FEATURE_DISABLED' })).toBe('failed');
  });
});
