import { describe, expect, it, vi } from 'vitest';
vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { routeCutover } from '@api/cf/cutover';
import type { CfBindings } from '@api/cf/bindings';

const SECRET = 'a'.repeat(32);
const ID = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const URL_ = (id: string, action: string) => `https://api.ebda.app/cutover/stores/${id}/${action}`;

function env(over: Partial<CfBindings> = {}) {
  const fetched: Request[] = [];
  const names: string[] = [];
  const STORE_DO = {
    idFromName: (n: string) => (names.push(n), n),
    get: () => ({
      fetch: async (r: Request) => (fetched.push(r), Response.json({ ok: true })),
    }),
  } as unknown as CfBindings['STORE_DO'];
  return { e: { CUTOVER_IMPORT_SECRET: SECRET, STORE_DO, ...over } as CfBindings, fetched, names };
}
const bearer = (s = SECRET) => ({ authorization: `Bearer ${s}` });

describe('routeCutover', () => {
  it('ignores paths outside /cutover/', async () => {
    expect(await routeCutover(new Request('https://api.ebda.app/health'), env().e)).toBeNull();
  });

  it('401 without a bearer, and the DO never sees the request', async () => {
    const { e, fetched } = env();
    const r = await routeCutover(new Request(URL_(ID, '__import'), { method: 'POST' }), e);
    expect(r?.status).toBe(401);
    expect(fetched).toHaveLength(0);
  });

  it('401 for a wrong or near-miss bearer', async () => {
    const { e, fetched } = env();
    for (const s of ['b'.repeat(32), SECRET + 'x', SECRET.slice(1)]) {
      const r = await routeCutover(
        new Request(URL_(ID, '__import'), { method: 'POST', headers: bearer(s) }),
        e
      );
      expect(r?.status).toBe(401);
    }
    expect(fetched).toHaveLength(0);
  });

  it('503 (fail closed) when the secret is unset or too short, even with a bearer', async () => {
    for (const secret of [undefined, '', 'short']) {
      const { e, fetched } = env({ CUTOVER_IMPORT_SECRET: secret });
      const r = await routeCutover(
        new Request(URL_(ID, '__status'), { headers: bearer(secret ?? '') }),
        e
      );
      expect(r?.status).toBe(503);
      expect(fetched).toHaveLength(0);
    }
  });

  it('auth is checked before the id and the method (no probing of the surface)', async () => {
    const { e } = env();
    const r = await routeCutover(new Request(URL_('not-an-id', '__nope')), e);
    expect(r?.status).toBe(401);
  });

  it('400 for a store id that is not a lowercase uuid', async () => {
    const { e, fetched } = env();
    for (const id of ['nope', ID.toUpperCase(), `${ID}x`, '..%2f..', ID.slice(1)]) {
      const r = await routeCutover(new Request(URL_(id, '__status'), { headers: bearer() }), e);
      expect(r?.status).toBe(400);
    }
    expect(fetched).toHaveLength(0);
  });

  it('404 for an unknown action, 405 for the wrong method', async () => {
    const { e } = env();
    expect(
      (await routeCutover(new Request(URL_(ID, '__sql'), { method: 'POST', headers: bearer() }), e))
        ?.status
    ).toBe(404);
    expect(
      (await routeCutover(new Request(URL_(ID, '__import'), { headers: bearer() }), e))?.status
    ).toBe(405);
    expect(
      (
        await routeCutover(
          new Request(URL_(ID, '__status'), { method: 'POST', headers: bearer() }),
          e
        )
      )?.status
    ).toBe(405);
  });

  it('routes every action to the DO named by the store id', async () => {
    const { e, fetched, names } = env();
    for (const a of ['__import', '__verify', '__seal', '__unseal', '__rebase', '__diff']) {
      const r = await routeCutover(
        new Request(URL_(ID, a), { method: 'POST', headers: bearer(), body: '{}' }),
        e
      );
      expect(r?.status).toBe(200);
    }
    const s = await routeCutover(new Request(URL_(ID, '__status'), { headers: bearer() }), e);
    expect(s?.status).toBe(200);
    // verify-store.mjs lists every DO's tables; a missing route made verify refuse every store on the deployed Worker
    const t = await routeCutover(new Request(URL_(ID, '__tables'), { headers: bearer() }), e);
    expect(t?.status).toBe(200);
    expect(fetched).toHaveLength(8);
    expect(new Set(names)).toEqual(new Set([ID]));
  });

  it('503 when STORE_DO is not bound', async () => {
    const { e } = env({ STORE_DO: undefined });
    const r = await routeCutover(new Request(URL_(ID, '__status'), { headers: bearer() }), e);
    expect(r?.status).toBe(503);
  });
});

describe('__analytics (Ruling NZ-AN-1)', () => {
  const post = (op: string) =>
    new Request(URL_(ID, '__analytics'), {
      method: 'POST',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ op, args: { confirm: ID } }),
    });
  const d1 = (marked: boolean) =>
    ({
      prepare: () => ({ bind: () => ({ first: async () => (marked ? { n: 1 } : null) }) }),
    }) as never;

  it('forwards the copy ops to the DO, which still receives the body', async () => {
    const { e, fetched } = env({ PLATFORM_DB: d1(false) } as never);
    const r = await routeCutover(post('analyticsImportStatus'), e);
    expect(r?.status).toBe(200);
    expect(fetched).toHaveLength(1);
    expect(((await fetched[0].json()) as { op: string }).op).toBe('analyticsImportStatus');
  });

  it('a reset is forwarded before the marker and refused 409 after it (the DO is never reached)', async () => {
    const before = env({ PLATFORM_DB: d1(false) } as never);
    expect((await routeCutover(post('analyticsImportReset'), before.e))?.status).toBe(200);
    expect(before.fetched).toHaveLength(1);
    const after = env({ PLATFORM_DB: d1(true) } as never);
    const r = await routeCutover(post('analyticsImportReset'), after.e);
    expect(r?.status).toBe(409);
    expect(after.fetched).toHaveLength(0);
  });

  it('a reset with the platform D1 unbound or unreadable is refused (fail closed)', async () => {
    const unbound = env();
    expect((await routeCutover(post('analyticsImportReset'), unbound.e))?.status).toBe(503);
    const broken = env({
      PLATFORM_DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              throw new Error('d1 down');
            },
          }),
        }),
      },
    } as never);
    expect((await routeCutover(post('analyticsImportReset'), broken.e))?.status).toBe(503);
    expect(broken.fetched).toHaveLength(0);
  });
});
