import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RETIRED_TEMPLATES, normalizeLegacyTemplate } from '@ebda/shared';

/**
 * A storefront that fails to resolve must say so.
 *
 * `getStoreOrNotFound` turns "no store" into `notFound()`, so when the API
 * answers 200 with `success:false` — or with a body carrying no store object —
 * every page of that storefront served a 404 and wrote NOTHING to the log.
 * Every OTHER failure path in this module logged; only these did not, so the
 * one shape that takes a whole shop dark was also the only one invisible.
 *
 * Found 2026-09-09 while trying to render a store locally: both resolution
 * paths returned null with an empty server log, which is what made it
 * undiagnosable rather than merely broken.
 *
 * These tests assert the LOG, not the return value — the null was always
 * correct behaviour. Deleting any of the four `console.error` calls in
 * store-resolver.ts must redden one of them.
 */

const headerBag = { value: new Map<string, string>() };

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerBag.value.get(k) ?? null }),
}));

class NotFoundError extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundError('NEXT_NOT_FOUND');
  },
}));

const { getStoreOrNotFound, resolveStoreBySlug, getStoreById } = await import('../store-resolver');

const fetchMock = vi.fn();
let errorSpy: ReturnType<typeof vi.spyOn>;

/** Unique per call — resolveStoreBySlug memoizes successful lookups by slug. */
let n = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${n++}`;

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  headerBag.value = new Map();
});
afterEach(() => {
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

const logged = () => errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

describe('slug resolution logs why it found no store', () => {
  it('logs when the API reports success:false', async () => {
    const slug = uniq('sf');
    fetchMock.mockResolvedValue(json({ success: false }));

    await expect(resolveStoreBySlug(slug)).resolves.toBeNull();

    expect(logged()).toContain(slug);
    expect(logged()).toContain('API reported success:false');
  });

  it('distinguishes a 200 that simply carried no store object', async () => {
    const slug = uniq('nostore');
    fetchMock.mockResolvedValue(json({ success: true, data: {} }));

    await expect(resolveStoreBySlug(slug)).resolves.toBeNull();

    expect(logged()).toContain('response carried no store object');
    // The two causes need different fixes, so they must not share one message.
    expect(logged()).not.toContain('success:false');
  });

  it('stays silent on the happy path', async () => {
    const slug = uniq('ok');
    fetchMock.mockResolvedValue(
      json({ success: true, data: { store: { id: 'store-1', slug, template: 'qamar' } } })
    );

    await expect(resolveStoreBySlug(slug)).resolves.not.toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('a store row still holding a retired Force skin (Ruling SKIN-DEL-8)', () => {
  it.each(RETIRED_TEMPLATES)(
    '%s renders as its mapped Ebda template at read time, with no write and no error',
    async stored => {
      const mapped = normalizeLegacyTemplate(stored);
      const slug = uniq(`legacy-${stored}`);
      fetchMock.mockResolvedValue(
        json({ success: true, data: { store: { id: 'store-1', slug, template: stored } } })
      );

      const store = await resolveStoreBySlug(slug);

      expect(store?.template).toBe(mapped);
      expect(errorSpy).not.toHaveBeenCalled();
    }
  );
});

describe('domain resolution — the path that takes a whole storefront dark', () => {
  it('logs before turning an unresolvable domain into a 404', async () => {
    headerBag.value.set('x-store-domain', 'shop.example.com');
    fetchMock.mockResolvedValue(json({ success: true, data: {} }));

    await expect(getStoreOrNotFound()).rejects.toBeInstanceOf(NotFoundError);

    expect(logged()).toContain('shop.example.com');
    expect(logged()).toContain('response carried no store object');
  });

  it('defangs a visitor-controlled domain before logging it', async () => {
    headerBag.value.set('x-store-domain', 'evil\n2026-01-01 FATAL forged-line');
    fetchMock.mockResolvedValue(json({ success: false }));

    await expect(getStoreOrNotFound()).rejects.toBeInstanceOf(NotFoundError);

    // The newline must not survive into the drain as a second log line.
    expect(logged()).not.toContain('\n2026-01-01 FATAL');
    expect(logged()).toContain('evil?2026-01-01 FATAL');
  });
});

describe('getStoreById reports its failures like its siblings', () => {
  it('logs a non-OK status', async () => {
    fetchMock.mockResolvedValue(json({}, 503));

    await expect(getStoreById('store-503')).resolves.toBeNull();

    expect(logged()).toContain('store-503');
    expect(logged()).toContain('503');
  });

  it('logs a 200 that carried no store', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: {} }));

    await expect(getStoreById('store-empty')).resolves.toBeNull();

    expect(logged()).toContain('store-empty');
    expect(logged()).toContain('response carried no store object');
  });
});
