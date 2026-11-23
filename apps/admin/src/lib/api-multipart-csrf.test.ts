// @vitest-environment jsdom
/** STORE-QA-56: apiFetch write requests (multipart uploads) carry the CSRF custom header. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from './api';

describe('apiFetch multipart write', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends X-Requested-With on POST with FormData and leaves Content-Type to the browser', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'r.png');
    await apiFetch('/api/v1/stores/s/billing/receipts', { method: 'POST', body: form });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h['X-Requested-With']).toBe('XMLHttpRequest');
    expect(h['Content-Type']).toBeUndefined();
  });

  it('does not add it to GET', async () => {
    await apiFetch('/api/v1/x');
    const h = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(h['X-Requested-With']).toBeUndefined();
  });
});
