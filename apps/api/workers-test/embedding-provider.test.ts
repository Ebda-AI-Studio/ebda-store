import { afterEach, describe, expect, it } from 'vitest';
import { clearCfBindings, setCfBindings, type CfBindings } from '../src/cf/bindings';
import {
  EMBED_DIMS,
  EMBED_MODEL,
  EmbeddingError,
  assertEmbeddingConfig,
  getEmbeddingProvider,
  semanticSearchEnabled,
} from '../src/lib/search/embedding-provider';

// Task 10 carry (Task 11): embed() inside the real workerd runtime — AbortSignal.any, timers and the
// binding call shape — with SEARCH_SEMANTIC_ENABLED=true and a fake `AI` binding (no network).
type Run = NonNullable<CfBindings['AI']>['run'];
function bindAi(run: Run) {
  setCfBindings({ AI: { run } });
}
const vec = (seed: number) => Array.from({ length: EMBED_DIMS }, (_, i) => ((seed + i) % 7) / 7);
const silentLog = { info: () => undefined };

describe('embedding provider in workerd (fake AI binding)', () => {
  afterEach(() => {
    clearCfBindings();
    delete process.env.SEARCH_SEMANTIC_ENABLED;
  });

  it('flag on + binding: boot check passes and embed() returns one vector per text', async () => {
    const seen: Array<{ model: string; input: Record<string, unknown>; signal?: AbortSignal }> = [];
    bindAi(async (model, input, opts) => {
      seen.push({ model, input, signal: opts?.signal });
      const texts = input.text as string[];
      return { shape: [texts.length, EMBED_DIMS], data: texts.map((_, i) => vec(i)) };
    });
    expect(navigator.userAgent).toBe('Cloudflare-Workers'); // really workerd, not Node
    process.env.SEARCH_SEMANTIC_ENABLED = 'true';
    expect(assertEmbeddingConfig(silentLog)).toEqual({ provider: 'workers-ai', semantic: true });
    expect(semanticSearchEnabled()).toBe(true);
    const out = await getEmbeddingProvider()!.embed(['كوتشي جلد', 'leather sneakers']);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(EMBED_DIMS);
    expect(seen[0].model).toBe(EMBED_MODEL);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("the caller's abort cancels the binding call (AbortSignal.any in workerd)", async () => {
    let bindingSignal: AbortSignal | undefined;
    bindAi(
      (_m, _i, opts) =>
        new Promise((_res, rej) => {
          bindingSignal = opts?.signal;
          opts?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        })
    );
    const ctl = new AbortController();
    const p = getEmbeddingProvider()!.embed(['x'], { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    const err = await p.catch(e => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).kind).toBe('aborted');
    expect(bindingSignal?.aborted).toBe(true);
  });

  it('a binding failure is a retryable provider error without the underlying message', async () => {
    bindAi(async () => {
      throw new Error('3040: out of capacity for input "secret text"');
    });
    const err = await getEmbeddingProvider()!
      .embed(['x'])
      .catch(e => e);
    expect(err).toMatchObject({ kind: 'provider', retryable: true });
    expect(String((err as Error).message)).not.toContain('secret');
  });
});
