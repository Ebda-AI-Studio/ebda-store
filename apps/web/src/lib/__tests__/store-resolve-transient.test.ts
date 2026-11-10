import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * "I could not reach the API" is not "this store does not exist".
 *
 * `fetchStoreByDomain` / `fetchStoreBySlug` used to collapse EVERY non-OK
 * response — 429, 500, 502, a dropped connection — into `null`, and
 * `getStoreOrNotFound()` / `getStoreByTenantParam()` turn `null` into Next's
 * `notFound()`. So a rate-limited or briefly-unhealthy API told a shopper the
 * shop does not exist, and told Google to drop the URL.
 *
 * `storeResolveLimiter` is 30/min keyed on `req.ip`, and Worker SSR
 * subrequests are counted under the VISITING SHOPPER's IP (measured
 * 2026-09-15), so the drained bucket is the shopper's own.
 *
 * These tests assert the CLASSIFICATION, not the copy: a definitive miss
 * (API 404, or a well-formed body carrying no store) must still 404, and
 * everything else must not. `notFound` is a spy so "did not 404" is asserted
 * directly rather than inferred from the error type.
 */

const hoisted = vi.hoisted(() => {
  class NotFoundError extends Error {}
  return { NotFoundError, notFound: vi.fn() };
});

const headerBag = { value: new Map<string, string>() };

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerBag.value.get(k) ?? null }),
}));

vi.mock('next/navigation', () => ({ notFound: hoisted.notFound }));

const { getStore, getStoreOrNotFound, getStoreByTenantParam, resolveStoreBySlug } =
  await import('../store-resolver');
const { StoreTemporarilyUnavailableError, STORE_UNAVAILABLE_DIGEST } =
  await import('../store-unavailable');

const fetchMock = vi.fn();
let errorSpy: ReturnType<typeof vi.spyOn>;

/** Unique per call — the resolver memoizes successful lookups by key. */
let n = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${n++}`;

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** A response whose body is not JSON at all (an HTML 502 page, a truncated read). */
const malformed = (status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    throw new SyntaxError('Unexpected token < in JSON at position 0');
  },
});

const storeBody = (slug: string) => ({
  success: true,
  data: { store: { id: `id-${slug}`, slug, template: 'qamar' } },
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  headerBag.value = new Map();
  // Re-established every test: the global setup's restoreAllMocks() strips the
  // implementation, and a `notFound` that silently returns instead of throwing
  // would let every assertion below pass for the wrong reason.
  hoisted.notFound.mockReset();
  hoisted.notFound.mockImplementation(() => {
    throw new hoisted.NotFoundError('NEXT_NOT_FOUND');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

/** Run `fn`, returning whatever it threw (or null when it resolved). */
const thrownBy = async (fn: () => Promise<unknown>) =>
  fn().then(
    () => null,
    e => e
  );

describe('a transient failure must NOT be rendered as "store not found"', () => {
  it('does not 404 when the store resolver is rate limited (429)', async () => {
    const domain = uniq('busy') + '.com';
    headerBag.value.set('x-store-domain', domain);
    fetchMock.mockResolvedValue(json({ success: false, error: { code: 'RATE_LIMITED' } }, 429));

    const err = await thrownBy(getStoreOrNotFound);

    expect(hoisted.notFound).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(StoreTemporarilyUnavailableError);
  });

  it('does not 404 when the API is unhealthy (503) on a <slug>.ebda.app host', async () => {
    const slug = uniq('down');
    headerBag.value.set('x-store-domain', `${slug}.ebda.app`);
    fetchMock.mockResolvedValue(json({}, 503));

    const err = await thrownBy(getStoreOrNotFound);

    expect(hoisted.notFound).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(StoreTemporarilyUnavailableError);
  });

  it('does not 404 when the connection fails outright', async () => {
    const domain = uniq('offline') + '.com';
    headerBag.value.set('x-store-domain', domain);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const err = await thrownBy(getStoreOrNotFound);

    expect(hoisted.notFound).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(StoreTemporarilyUnavailableError);
  });

  it('does not 404 when the response body will not parse', async () => {
    const domain = uniq('garbled') + '.com';
    headerBag.value.set('x-store-domain', domain);
    fetchMock.mockResolvedValue(malformed(200));

    const err = await thrownBy(getStoreOrNotFound);

    expect(hoisted.notFound).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(StoreTemporarilyUnavailableError);
  });

  it('carries the digest app/error.tsx keys on, so the shopper gets retry copy', async () => {
    const domain = uniq('digest') + '.com';
    headerBag.value.set('x-store-domain', domain);
    fetchMock.mockResolvedValue(json({}, 502));

    const err = await thrownBy(getStoreOrNotFound);

    expect((err as { digest?: string }).digest).toBe(STORE_UNAVAILABLE_DIGEST);
  });
});

describe('a definitive miss must still 404 — the tenant-isolation invariant', () => {
  it('404s when the API says the domain belongs to no store', async () => {
    const domain = uniq('nosuch') + '.com';
    headerBag.value.set('x-store-domain', domain);
    fetchMock.mockResolvedValue(json({ success: false, error: { code: 'STORE_NOT_FOUND' } }, 404));

    const err = await thrownBy(getStoreOrNotFound);

    expect(hoisted.notFound).toHaveBeenCalled();
    expect(err).toBeInstanceOf(hoisted.NotFoundError);
  });

  it('404s when the API says the <slug>.ebda.app host belongs to no store', async () => {
    headerBag.value.set('x-store-domain', `${uniq('ghost')}.ebda.app`);
    fetchMock.mockResolvedValue(json({ success: false, error: { code: 'NOT_FOUND' } }, 404));

    const err = await thrownBy(getStoreOrNotFound);

    expect(hoisted.notFound).toHaveBeenCalled();
    expect(err).toBeInstanceOf(hoisted.NotFoundError);
  });

  it('404s on a well-formed 200 that carries no store, and still logs first', async () => {
    const domain = uniq('empty') + '.com';
    headerBag.value.set('x-store-domain', domain);
    fetchMock.mockResolvedValue(json({ success: true, data: {} }));

    const err = await thrownBy(getStoreOrNotFound);

    expect(hoisted.notFound).toHaveBeenCalled();
    expect(err).toBeInstanceOf(hoisted.NotFoundError);
    expect(errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain(
      'response carried no store object'
    );
  });
});

describe('getStoreByTenantParam makes the same distinction', () => {
  it('does not 404 a tenant route on a 429', async () => {
    fetchMock.mockResolvedValue(json({ success: false }, 429));

    const err = await thrownBy(() => getStoreByTenantParam(`${uniq('t-busy')}.ebda.app`));

    expect(hoisted.notFound).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(StoreTemporarilyUnavailableError);
  });

  it('still 404s a tenant route whose store genuinely does not exist', async () => {
    fetchMock.mockResolvedValue(json({ success: false }, 404));

    const err = await thrownBy(() => getStoreByTenantParam(`${uniq('t-ghost')}.ebda.app`));

    expect(hoisted.notFound).toHaveBeenCalled();
    expect(err).toBeInstanceOf(hoisted.NotFoundError);
  });
});

describe('the lenient resolver still never throws into the layout', () => {
  it('falls back to the default store on a 429 instead of taking the chrome down', async () => {
    const domain = uniq('lenient') + '.com';
    headerBag.value.set('x-store-domain', domain);
    fetchMock.mockResolvedValue(json({ success: false }, 429));

    // app/layout.tsx, its generateMetadata, app/not-found.tsx, the web app manifest and
    // the favicon route all call this. If it threw, the retry page would lose
    // the layout it renders inside and fall through to global-error.tsx.
    await expect(getStore()).resolves.toMatchObject({ id: 'demo' });

    // ...and it must MARK the fallback as transient. `layout.tsx` keys on the
    // `id === 'demo'` sentinel to emit `title: 'Page not found — Ebda'`, so
    // without this flag the retry BODY renders inside a document whose TITLE
    // says the store does not exist — the same claim, relocated to the head.
    await expect(getStore()).resolves.toMatchObject({ transientResolveFailure: true });
  });
});

describe('a transient outcome is never remembered', () => {
  it('re-fetches after a 429 rather than caching the failure', async () => {
    const slug = uniq('recovers');
    fetchMock.mockResolvedValueOnce(json({ success: false }, 429));

    await expect(resolveStoreBySlug(slug)).rejects.toBeInstanceOf(StoreTemporarilyUnavailableError);

    // Same slug, API healthy again: the shopper must get the store, not a
    // memoized failure.
    fetchMock.mockResolvedValueOnce(json(storeBody(slug)));
    await expect(resolveStoreBySlug(slug)).resolves.toMatchObject({ slug });
  });
});
