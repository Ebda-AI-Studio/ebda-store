/**
 * The storefront's server fetch of a page document (Ruling VE-3 amended): the published one for visitors,
 * the draft for a valid editor token, and never an error page when anything goes wrong.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultPageDocument } from '@ebda/shared';
import { fetchPageDocument, builderTokenFrom } from '../../apps/web/src/lib/page-document';

const ok = (definition: unknown) => ({ ok: true, json: async () => ({ data: { definition } }) });
const TOKEN = 'A'.repeat(24);

afterEach(() => vi.unstubAllGlobals());

describe('fetchPageDocument', () => {
  it('visitors get the published document, cached 60 s under the layout tag', async () => {
    const f = vi.fn(async () => ok(defaultPageDocument('cart')));
    vi.stubGlobal('fetch', f);
    const r = await fetchPageDocument('s1', 'cart');
    expect(r).toEqual({ definition: defaultPageDocument('cart'), editorMode: false });
    const [url, init] = f.mock.calls[0] as unknown as [string, { next: unknown }];
    expect(url).toMatch(/\/public\/stores\/s1\/pages\/cart$/);
    expect(init.next).toEqual({ revalidate: 60, tags: ['layout:s1'] });
  });

  it('an editor token renders the draft, uncached, in editor mode', async () => {
    const f = vi.fn(async () => ok(defaultPageDocument('product')));
    vi.stubGlobal('fetch', f);
    const r = await fetchPageDocument('s1', 'product', TOKEN);
    expect(r?.editorMode).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, { cache: string }];
    expect(url).toContain(`/builder-preview?token=${TOKEN}`);
    expect(init.cache).toBe('no-store');
  });

  it("a token minted for another page is ignored: the product canvas never renders the cart's draft", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok(defaultPageDocument('cart'))) // builder-preview says: a cart draft
      .mockResolvedValueOnce(ok(defaultPageDocument('product'))); // then the published product page
    vi.stubGlobal('fetch', f);
    const r = await fetchPageDocument('s1', 'product', TOKEN);
    expect(r).toEqual({ definition: defaultPageDocument('product'), editorMode: false });
  });

  it("a failure, an invalid document or the demo store returns undefined (today's order), never throws", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }))
    );
    expect(await fetchPageDocument('s1', 'cart')).toBeUndefined();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ nonsense: true }))
    );
    expect(await fetchPageDocument('s1', 'cart')).toBeUndefined();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      })
    );
    expect(await fetchPageDocument('s1', 'cart')).toBeUndefined();
    const never = vi.fn();
    vi.stubGlobal('fetch', never);
    expect(await fetchPageDocument('demo', 'cart')).toBeUndefined();
    expect(never).not.toHaveBeenCalled();
  });

  it('the builder token only counts inside the admin preview iframe', () => {
    expect(builderTokenFrom({ _builder: TOKEN, _preview: '' })).toBe(TOKEN);
    expect(builderTokenFrom({ _builder: TOKEN })).toBeUndefined();
    expect(builderTokenFrom({ _preview: '' })).toBeUndefined();
    expect(builderTokenFrom({ _builder: ['a', 'b'], _preview: '' })).toBeUndefined();
  });
});
