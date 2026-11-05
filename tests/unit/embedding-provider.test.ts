import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';
import {
  getEmbeddingProvider,
  setEmbeddingProviderForTests,
  toHalfvecLiteral,
  EMBED_DIMS,
  EMBED_MAX_BATCH,
  EMBED_MODEL,
  EMBED_TIMEOUT_MS,
  semanticSearchEnabled,
  assertEmbeddingConfig,
  EmbeddingError,
} from '../../apps/api/src/lib/search/embedding-provider';

afterEach(() => {
  clearCfBindings();
  setEmbeddingProviderForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const vec = () => Array.from({ length: EMBED_DIMS }, (_, i) => i / EMBED_DIMS);
const withAi = (
  run: (model: string, input: Record<string, unknown>, opts?: unknown) => Promise<unknown>
) => setCfBindings({ AI: { run } } as never);

describe('embedding provider', () => {
  it('uses the AI binding when present', async () => {
    const run = vi.fn(async () => ({ shape: [1, EMBED_DIMS], data: [vec()] }));
    withAi(run);
    const out = await getEmbeddingProvider()!.embed(['أحذية']);
    expect(run).toHaveBeenCalledWith(
      '@cf/baai/bge-m3',
      { text: ['أحذية'] },
      { signal: expect.any(AbortSignal) }
    );
    expect(out[0]).toHaveLength(EMBED_DIMS);
  });
  it('rejects a wrong-dimension answer loudly', async () => {
    withAi(async () => ({ data: [[1, 2]] }));
    await expect(getEmbeddingProvider()!.embed(['x'])).rejects.toThrow(/expected 1024/);
  });
  it('rejects a wrong vector count and a non-finite component', async () => {
    withAi(async () => ({ data: [vec()] }));
    await expect(getEmbeddingProvider()!.embed(['a', 'b'])).rejects.toThrow(/expected 2 vectors/);
    const bad = vec();
    bad[5] = Number.NaN;
    withAi(async () => ({ data: [bad] }));
    await expect(getEmbeddingProvider()!.embed(['a'])).rejects.toThrow(/finite/);
  });
  it('falls back to REST when only credentials exist', async () => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, result: { data: [vec()] } }))
      );
    await getEmbeddingProvider()!.embed(['x']);
    expect(String(f.mock.calls[0][0])).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/baai/bge-m3'
    );
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({ text: ['x'] });
  });
  it('REST failure throws without echoing the token', async () => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok-secret-value');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));
    const err = await getEmbeddingProvider()!
      .embed(['x'])
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/embedding REST 401/);
    expect(String(err)).not.toMatch(/tok-secret-value/);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ code: 5006 }] }))
    );
    await expect(getEmbeddingProvider()!.embed(['x'])).rejects.toThrow(/success=false/);
  });
  it('REST 200 with a non-JSON body never quotes the body (review M1)', async () => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>proxy page leaked-value</html>', { status: 200 })
    );
    const err = await getEmbeddingProvider()!
      .embed(['x'])
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/embedding REST: non-JSON body/);
    expect(String(err)).not.toMatch(/html|leaked-value/);
  });
  it('REST splits into ordered batches of at most 100 (review M6)', async () => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    const sizes: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      const text = JSON.parse(String((init as RequestInit).body)).text as string[];
      sizes.push(text.length);
      return new Response(
        JSON.stringify({
          success: true,
          result: { data: text.map(t => [Number(t), ...vec().slice(1)]) },
        })
      );
    });
    const texts = Array.from({ length: 150 }, (_, i) => String(i));
    const out = await getEmbeddingProvider()!.embed(texts);
    expect(sizes).toEqual([100, 50]);
    expect(out.map(v => v[0])).toEqual(texts.map(Number));
  });
  it.each([
    ['success with no result', { success: true }],
    ['result with no data', { success: true, result: {} }],
    ['a JSON null body', null],
  ])('REST %s is a permanent shape error (review M6)', async (_name, body) => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(getEmbeddingProvider()!.embed(['x'])).rejects.toMatchObject({
      kind: 'shape',
      retryable: false,
      message: expect.stringMatching(/expected 1 vectors/),
    });
  });
  it('the binding wins over REST credentials', async () => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    const f = vi.spyOn(globalThis, 'fetch');
    const run = vi.fn(async () => ({ data: [vec()] }));
    withAi(run);
    await getEmbeddingProvider()!.embed(['x']);
    expect(run).toHaveBeenCalledOnce();
    expect(f).not.toHaveBeenCalled();
  });
  it('splits more than EMBED_MAX_BATCH texts into ordered calls of at most 100', async () => {
    expect(EMBED_MAX_BATCH).toBe(100);
    const calls: number[] = [];
    withAi(async (_m, input) => {
      const text = input.text as string[];
      calls.push(text.length);
      // Encode the input index in component 0 so order is checkable.
      return { data: text.map(t => [Number(t), ...vec().slice(1)]) };
    });
    const texts = Array.from({ length: 205 }, (_, i) => String(i));
    const out = await getEmbeddingProvider()!.embed(texts);
    expect(calls).toEqual([100, 100, 5]);
    expect(out.map(v => v[0])).toEqual(texts.map(Number));
  });
  it('empty input makes no call; an empty string is refused before the call', async () => {
    const run = vi.fn(async () => ({ data: [vec()] }));
    withAi(run);
    expect(await getEmbeddingProvider()!.embed([])).toEqual([]);
    await expect(getEmbeddingProvider()!.embed(['ok', '  '])).rejects.toThrow(/empty text/);
    expect(run).not.toHaveBeenCalled();
  });
  it('a binding call that never answers times out', async () => {
    vi.useFakeTimers();
    withAi(() => new Promise(() => undefined));
    const p = getEmbeddingProvider()!.embed(['x']);
    const settled = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS + 1);
    await settled;
  });
  it('the binding gets a signal; a timeout aborts it (cancels, not just abandons)', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    withAi((_m, _i, opts) => {
      seen = (opts as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise(() => undefined);
    });
    const p = getEmbeddingProvider()!.embed(['x']);
    const settled = expect(p).rejects.toThrow(/timed out/);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS + 1);
    await settled;
    expect(seen!.aborted).toBe(true);
  });
  it('a caller abort rejects promptly and aborts the in-flight binding call', async () => {
    let seen: AbortSignal | undefined;
    withAi((_m, _i, opts) => {
      seen = (opts as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise(() => undefined); // ignores the signal: embed must not wait for it
    });
    const ctl = new AbortController();
    const p = getEmbeddingProvider()!.embed(['x'], { signal: ctl.signal });
    const t0 = Date.now();
    ctl.abort();
    await expect(p).rejects.toThrow(/aborted/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(seen!.aborted).toBe(true);
  });
  it('an already-aborted caller signal makes no call', async () => {
    const run = vi.fn(async () => ({ data: [vec()] }));
    withAi(run);
    const ctl = new AbortController();
    ctl.abort();
    await expect(getEmbeddingProvider()!.embed(['x'], { signal: ctl.signal })).rejects.toThrow(
      /aborted/
    );
    expect(run).not.toHaveBeenCalled();
  });
  it('REST: a caller abort reaches fetch and rejects promptly', async () => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    let seen: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_u, init) => {
      seen = (init as RequestInit).signal ?? undefined;
      return new Promise(() => undefined);
    });
    const ctl = new AbortController();
    const p = getEmbeddingProvider()!.embed(['x'], { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toThrow(/aborted/);
    expect(seen!.aborted).toBe(true);
  });
  it('null provider and disabled semantic search when nothing is configured', () => {
    expect(getEmbeddingProvider()).toBeNull();
    vi.stubEnv('SEARCH_SEMANTIC_ENABLED', 'true');
    expect(semanticSearchEnabled()).toBe(false);
  });
  it('semantic search needs the flag AND a provider', () => {
    withAi(async () => ({ data: [vec()] }));
    expect(semanticSearchEnabled()).toBe(false);
    vi.stubEnv('SEARCH_SEMANTIC_ENABLED', 'TRUE');
    expect(semanticSearchEnabled()).toBe(false);
    vi.stubEnv('SEARCH_SEMANTIC_ENABLED', 'true');
    expect(semanticSearchEnabled()).toBe(true);
  });
  it('the test override wins, including an explicit null', () => {
    withAi(async () => ({ data: [vec()] }));
    setEmbeddingProviderForTests(null);
    expect(getEmbeddingProvider()).toBeNull();
    const fake = { model: EMBED_MODEL, embed: async () => [] };
    setEmbeddingProviderForTests(fake);
    expect(getEmbeddingProvider()).toBe(fake);
  });
  it('halfvec literal', () => {
    const v = vec();
    v[0] = 0.5;
    v[1] = -1;
    expect(toHalfvecLiteral(v)).toBe(`[${v.join(',')}]`);
    expect(toHalfvecLiteral(v).startsWith('[0.5,-1,')).toBe(true);
  });
  it('halfvec literal refuses a wrong length or a non-finite value (review M3)', () => {
    expect(() => toHalfvecLiteral([0.5, -1])).toThrow(/expected 1024/);
    const nan = vec();
    nan[3] = Number.NaN;
    expect(() => toHalfvecLiteral(nan)).toThrow(/finite/);
    const inf = vec();
    inf[3] = Number.POSITIVE_INFINITY;
    expect(() => toHalfvecLiteral(inf)).toThrow(/finite/);
  });
  it('EMBED_DIMS matches the halfvec column in the migration and the Prisma schema', () => {
    const mig = readFileSync(
      'packages/database/prisma/migrations/20261022000100_product_embeddings/migration.sql',
      'utf8'
    );
    const schema = readFileSync('packages/database/prisma/schema.prisma', 'utf8');
    const migDims = [...mig.matchAll(/halfvec\((\d+)\)/g)].map(m => Number(m[1]));
    const schemaDims = [...schema.matchAll(/halfvec\((\d+)\)/g)].map(m => Number(m[1]));
    expect(migDims.length).toBeGreaterThan(0);
    expect(schemaDims.length).toBeGreaterThan(0);
    for (const d of [...migDims, ...schemaDims]) expect(d).toBe(EMBED_DIMS);
  });
});

describe('EmbeddingError: retryable vs permanent (review M2)', () => {
  const rest = (res: Response | Promise<Response>) => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(res));
  };
  const fail = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e as EmbeddingError
    );

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
  ])('REST %i -> kind http, retryable %s', async (status, retryable) => {
    rest(new Response('x', { status }));
    const e = await fail(getEmbeddingProvider()!.embed(['x']));
    expect(e).toBeInstanceOf(EmbeddingError);
    expect(e).toMatchObject({ kind: 'http', status, retryable });
  });
  it('network failure is retryable', async () => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    expect(await fail(getEmbeddingProvider()!.embed(['x']))).toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });
  it('a throwing binding is retryable (Workers AI capacity errors)', async () => {
    withAi(async () => {
      throw new Error('3040: Capacity temporarily exceeded');
    });
    expect(await fail(getEmbeddingProvider()!.embed(['x']))).toMatchObject({
      kind: 'provider',
      retryable: true,
    });
  });
  it('timeout and caller abort are retryable', async () => {
    vi.useFakeTimers();
    withAi(() => new Promise(() => undefined));
    const p = fail(getEmbeddingProvider()!.embed(['x']));
    await vi.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS + 1);
    expect(await p).toMatchObject({ kind: 'timeout', retryable: true });
    vi.useRealTimers();
    const ctl = new AbortController();
    const q = fail(getEmbeddingProvider()!.embed(['x'], { signal: ctl.signal }));
    ctl.abort();
    expect(await q).toMatchObject({ kind: 'aborted', retryable: true });
  });
  it('a wrong shape, an empty text and success=false are permanent', async () => {
    withAi(async () => ({ data: [[1, 2]] }));
    expect(await fail(getEmbeddingProvider()!.embed(['x']))).toMatchObject({
      kind: 'shape',
      retryable: false,
    });
    expect(await fail(getEmbeddingProvider()!.embed([' ']))).toMatchObject({
      kind: 'input',
      retryable: false,
    });
    clearCfBindings();
    rest(new Response(JSON.stringify({ success: false })));
    expect(await fail(getEmbeddingProvider()!.embed(['x']))).toMatchObject({
      kind: 'provider',
      retryable: false,
    });
  });
});

describe('assertEmbeddingConfig (boot check)', () => {
  const log = () => ({ info: vi.fn(), warn: vi.fn() });

  it('nothing configured and flag off: explicit "none", logged, no throw', () => {
    const l = log();
    expect(assertEmbeddingConfig(l)).toEqual({ provider: 'none', semantic: false });
    expect(l.info).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'none', semantic: false }),
      expect.stringMatching(/semantic search OFF/)
    );
  });
  it('flag on with no provider fails loudly instead of degrading silently', () => {
    vi.stubEnv('SEARCH_SEMANTIC_ENABLED', 'true');
    expect(() => assertEmbeddingConfig(log())).toThrow(
      /SEARCH_SEMANTIC_ENABLED=true but no embedding provider/
    );
  });
  it('half-configured REST credentials fail loudly, even with the flag off', () => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    expect(() => assertEmbeddingConfig(log())).toThrow(/CF_AI_ACCOUNT_ID and CF_AI_API_TOKEN/);
    vi.unstubAllEnvs();
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    expect(() => assertEmbeddingConfig(log())).toThrow(/CF_AI_ACCOUNT_ID and CF_AI_API_TOKEN/);
  });
  it('reports the resolved provider', () => {
    vi.stubEnv('SEARCH_SEMANTIC_ENABLED', 'true');
    withAi(async () => ({ data: [vec()] }));
    expect(assertEmbeddingConfig(log())).toEqual({ provider: 'workers-ai', semantic: true });
    clearCfBindings();
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    expect(assertEmbeddingConfig(log())).toEqual({ provider: 'rest', semantic: true });
  });
  it('uses the same resolution as getEmbeddingProvider, test override included (review M4)', () => {
    vi.stubEnv('SEARCH_SEMANTIC_ENABLED', 'true');
    setEmbeddingProviderForTests({ model: EMBED_MODEL, embed: async () => [] });
    expect(assertEmbeddingConfig(log())).toEqual({ provider: 'test', semantic: true });
    withAi(async () => ({ data: [vec()] }));
    setEmbeddingProviderForTests(null);
    expect(getEmbeddingProvider()).toBeNull();
    expect(() => assertEmbeddingConfig(log())).toThrow(/no embedding provider/);
  });
  it('an unrecognised flag value is refused, not read as off', () => {
    vi.stubEnv('SEARCH_SEMANTIC_ENABLED', 'yes');
    expect(() => assertEmbeddingConfig(log())).toThrow(/SEARCH_SEMANTIC_ENABLED/);
  });
});

describe('boot shells run the embedding config check', () => {
  it('worker.ts (per isolate, before any request work) and index.ts (before listen)', () => {
    const worker = readFileSync('apps/api/src/worker.ts', 'utf8');
    const prepare = worker.slice(worker.indexOf('function prepare('));
    expect(prepare.slice(0, prepare.indexOf('\n}\n'))).toMatch(/assertEmbeddingConfig\(logger\)/);
    const node = readFileSync('apps/api/src/index.ts', 'utf8');
    expect(node.indexOf('assertEmbeddingConfig(logger)')).toBeGreaterThan(-1);
    expect(node.indexOf('assertEmbeddingConfig(logger)')).toBeLessThan(
      node.indexOf('createServer(app)')
    );
  });
});
