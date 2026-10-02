/**
 * `apiGetPage` keeps the `meta` that `apiGet` drops (issue 2417).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiGet, apiGetPage } from '../../apps/admin/src/lib/api';

const BODY = {
  data: [{ id: 'a' }, { id: 'b' }],
  meta: { page: 1, perPage: 2, total: 73, totalPages: 37 },
};

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('apiGetPage', () => {
  it('returns the items AND the meta', async () => {
    stubFetch(200, { success: true, ...BODY });
    const res = await apiGetPage<{ id: string }>('/api/v1/x');
    expect(res.error).toBeNull();
    expect(res.data).toEqual(BODY.data);
    expect(res.meta).toEqual(BODY.meta);
  });

  it('control: apiGet on the same response drops the meta (why the helper exists)', async () => {
    stubFetch(200, { success: true, ...BODY });
    const res = await apiGet<unknown[]>('/api/v1/x');
    expect(res.data).toEqual(BODY.data);
    expect((res.data as unknown as { meta?: unknown }).meta).toBeUndefined();
  });

  it('meta is null when the route sends none', async () => {
    stubFetch(200, { success: true, data: [] });
    const res = await apiGetPage('/api/v1/x');
    expect(res.data).toEqual([]);
    expect(res.meta).toBeNull();
  });

  it('maps an error response to the ApiError shape, with no data and no meta', async () => {
    stubFetch(403, { success: false, error: { code: 'FORBIDDEN', message: 'nope' } });
    const res = await apiGetPage('/api/v1/x');
    expect(res.data).toBeNull();
    expect(res.meta).toBeNull();
    expect(res.error).toMatchObject({ code: 'FORBIDDEN', message: 'nope', status: 403 });
  });

  it('maps a network failure to NETWORK_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    const res = await apiGetPage('/api/v1/x');
    expect(res.error).toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });
});
