/**
 * API-HANG-1: an AuthState Durable Object call can no longer hold a request open, and a cache fill on Workers answers
 * before its write-back (generation check -> KV put -> re-check) instead of after it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/lib/runtime', async orig => ({
  ...(await orig<typeof import('../../apps/api/src/lib/runtime')>()),
  isWorkers: true,
}));

const gens = vi.fn<(names: string[]) => Promise<Array<string | null>>>();
const kv = new Map<string, string>();
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => void kv.set(k, v),
    delete: async (k: string) => void kv.delete(k),
    getCacheGenerations: (names: string[]) => gens(names),
    bumpCacheGeneration: async () => undefined,
  },
}));

import {
  AUTH_STATE_TIMEOUT_MS,
  AuthStateTimeoutError,
  applyOn,
  withAuthStateDeadline,
} from '../../apps/api/src/cf/auth-state-client';
import { clearCfBindings, setCfBindings, type CfBindings } from '../../apps/api/src/cf/bindings';
import { getCached } from '../../apps/api/src/lib/public-cache';

afterEach(() => {
  vi.useRealTimers();
  clearCfBindings();
  kv.clear();
  gens.mockReset();
});

describe('AuthState deadline', () => {
  it('a call that never settles rejects with AuthStateTimeoutError at the deadline', async () => {
    vi.useFakeTimers();
    const p = withAuthStateDeadline('do-test-get', new Promise<never>(() => undefined));
    const assertion = expect(p).rejects.toBeInstanceOf(AuthStateTimeoutError);
    await vi.advanceTimersByTimeAsync(AUTH_STATE_TIMEOUT_MS - 1);
    let settled = false;
    p.catch(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('a call that answers in time is returned unchanged, and its failure is its own', async () => {
    await expect(withAuthStateDeadline('x', Promise.resolve([1]))).resolves.toEqual([1]);
    await expect(withAuthStateDeadline('x', Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );
  });

  it('a BOUNDED applyOn against a stuck instance fails fast instead of hanging the request', async () => {
    vi.useFakeTimers();
    setCfBindings({
      AUTH_STATE: {
        idFromName: (n: string) => n,
        get: () => ({ apply: () => new Promise<never>(() => undefined) }),
      },
    } as unknown as CfBindings);
    const p = applyOn('rl:public:10.0.0.1', [['hit', 'rl:public:10.0.0.1', 60_000]], {
      bounded: true,
    });
    const assertion = expect(p).rejects.toBeInstanceOf(AuthStateTimeoutError);
    await vi.advanceTimersByTimeAsync(AUTH_STATE_TIMEOUT_MS);
    await assertion;
  });
});

describe('unbounded calls keep their old semantics', () => {
  it('an unbounded applyOn (bumps, jti, lockout, locks) is NOT cut off at the deadline', async () => {
    vi.useFakeTimers();
    let answer!: (v: unknown[]) => void;
    setCfBindings({
      AUTH_STATE: {
        idFromName: (n: string) => n,
        get: () => ({ apply: () => new Promise<unknown[]>(r => (answer = r)) }),
      },
    } as unknown as CfBindings);
    const p = applyOn('jti:deny:abc', [['get', 'jti:deny:abc']]);
    let outcome = 'pending';
    p.then(
      () => (outcome = 'ok'),
      () => (outcome = 'rejected')
    );
    await vi.advanceTimersByTimeAsync(AUTH_STATE_TIMEOUT_MS * 3);
    expect(outcome).toBe('pending');
    answer(['1']);
    await expect(p).resolves.toEqual(['1']);
  });
});

describe('getCached on Workers: write-back after the response', () => {
  it('answers without waiting for the write-back; the write-back still checks, writes, re-checks', async () => {
    const pendingWrite: Array<Promise<unknown>> = [];
    const bindings = await import('../../apps/api/src/cf/bindings');
    const spy = vi
      .spyOn(bindings, 'cfWaitUntil')
      .mockImplementation(p => void pendingWrite.push(p));
    let unblock!: () => void;
    const blocked = new Promise<void>(r => (unblock = r));
    gens
      .mockResolvedValueOnce(['1', '0', '0'])
      // the write-back's generation read is stuck: the response must not wait for it
      .mockImplementationOnce(async () => (await blocked, ['1', '0', '0']))
      .mockResolvedValue(['1', '0', '0']);

    const value = await getCached('public:store:demo', 60, async () => ({ id: 'demo' }));
    expect(value).toEqual({ id: 'demo' });
    expect(pendingWrite).toHaveLength(1);
    expect(kv.has('public:store:demo')).toBe(false);
    unblock();
    await Promise.all(pendingWrite);
    expect(gens).toHaveBeenCalledTimes(3); // before the fetch, before the put, after the put
    expect(kv.get('public:store:demo')).toBe(JSON.stringify({ id: 'demo' }));
    spy.mockRestore();
  });

  it('a generation bumped during the fetch keeps the stale value out of the cache', async () => {
    const pendingWrite: Array<Promise<unknown>> = [];
    const bindings = await import('../../apps/api/src/cf/bindings');
    const spy = vi
      .spyOn(bindings, 'cfWaitUntil')
      .mockImplementation(p => void pendingWrite.push(p));
    gens.mockResolvedValueOnce(['1', '0', '0']).mockResolvedValue(['2', '0', '0']);

    await getCached('public:store:bumped', 60, async () => ({ price: 'old' }));
    await Promise.all(pendingWrite);
    expect(kv.has('public:store:bumped')).toBe(false);
    spy.mockRestore();
  });

  it('a bump between the put and the re-check takes the entry back out', async () => {
    const pendingWrite: Array<Promise<unknown>> = [];
    const bindings = await import('../../apps/api/src/cf/bindings');
    const spy = vi
      .spyOn(bindings, 'cfWaitUntil')
      .mockImplementation(p => void pendingWrite.push(p));
    gens
      .mockResolvedValueOnce(['1', '0', '0'])
      .mockResolvedValueOnce(['1', '0', '0'])
      .mockResolvedValue(['2', '0', '0']);

    await getCached('public:store:raced', 60, async () => ({ price: 'old' }));
    await Promise.all(pendingWrite);
    expect(kv.has('public:store:raced')).toBe(false);
    spy.mockRestore();
  });
});
