import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCustomPage, metaDescriptionFrom } from './custom-page';

const page = {
  slug: 'qa-test-page',
  title: 'QA page',
  titleAr: 'صفحة اختبار',
  contentHtml: '<p>Hello</p>',
  contentHtmlAr: '<p>أهلا</p>',
};
const reply = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({ status, ok: status >= 200 && status < 300, json: async () => body });

afterEach(() => vi.unstubAllGlobals());

describe('fetchCustomPage (the /pages/<slug> route 404s on null)', () => {
  it('a published page of this store is returned, asked by THIS store id', async () => {
    const f = reply(200, { data: { page } });
    vi.stubGlobal('fetch', f);
    expect((await fetchCustomPage('store-a', 'qa-test-page'))?.title).toBe('QA page');
    expect(String(f.mock.calls[0][0])).toContain('/public/store-a/pages/qa-test-page');
  });
  it('an Arabic slug is sent encoded', async () => {
    const f = reply(200, { data: { page: { ...page, slug: 'صفحة-اختبار' } } });
    vi.stubGlobal('fetch', f);
    await fetchCustomPage('store-a', 'صفحة-اختبار');
    expect(String(f.mock.calls[0][0])).toContain(encodeURIComponent('صفحة-اختبار'));
  });
  it('a draft (410) is null', async () => {
    vi.stubGlobal('fetch', reply(410, {}));
    expect(await fetchCustomPage('store-a', 'qa-test-page')).toBeNull();
  });
  it("another store's slug (no row for THIS store) is null", async () => {
    vi.stubGlobal('fetch', reply(200, { data: { page: null } }));
    expect(await fetchCustomPage('store-b', 'qa-test-page')).toBeNull();
  });
  it('a standard page is never served here, and no request is made', async () => {
    const f = reply(200, { data: { page } });
    vi.stubGlobal('fetch', f);
    expect(await fetchCustomPage('store-a', 'privacy')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it('a page with no body is null; a 5xx throws instead of a false 404', async () => {
    vi.stubGlobal(
      'fetch',
      reply(200, { data: { page: { ...page, contentHtml: '', contentHtmlAr: ' ' } } })
    );
    expect(await fetchCustomPage('store-a', 'qa-test-page')).toBeNull();
    vi.stubGlobal('fetch', reply(503, {}));
    await expect(fetchCustomPage('store-a', 'qa-test-page')).rejects.toThrow();
  });
});

describe('metaDescriptionFrom', () => {
  it('strips tags and cuts long text', () => {
    expect(metaDescriptionFrom('<h2>Hi</h2><p>there &amp; you</p>')).toBe('Hi there you');
    expect(metaDescriptionFrom(`<p>${'a'.repeat(300)}</p>`).length).toBeLessThanOrEqual(160);
  });
});
