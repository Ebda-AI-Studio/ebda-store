import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const PHONE = '01012345678';
let calls: { url: string; headers: Record<string, string> }[] = [];

beforeEach(() => {
  calls = [];
  api.setStoreId('11111111-1111-4111-8111-111111111111');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('the storefront API client sends the search term in a header', () => {
  it('getProducts: search leaves the URL, the other filters stay', async () => {
    await api.getProducts({ search: PHONE, category: 'c1', page: '2' });
    expect(calls[0].url).not.toContain(PHONE);
    expect(calls[0].url).not.toMatch(/search=/);
    expect(calls[0].url).toContain('category=c1');
    expect(calls[0].url).toContain('page=2');
    expect(calls[0].headers['X-Search-Query']).toBe(PHONE);
  });

  it('getProducts without a term sends no search header', async () => {
    await api.getProducts({ category: 'c1' });
    expect(calls[0].headers['X-Search-Query']).toBeUndefined();
  });

  it('searchSuggest: the term is in the header, never the URL', async () => {
    await api.searchSuggest(`منى ${PHONE}`);
    expect(calls[0].url).not.toContain(PHONE);
    expect(calls[0].url).not.toMatch(/[?&]q=/);
    expect(calls[0].url).toMatch(/\/search\/suggest$/);
    expect(decodeURIComponent(calls[0].headers['X-Search-Query'])).toBe(`منى ${PHONE}`);
  });
});
