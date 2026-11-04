/**
 * BE:E-1: the identity RPCs on every authenticated request have a 3 s budget (503, never a hang or an allow), concurrent
 * requests share ONE account-state lookup, only a positive answer is cached, and the Store paths that change an account
 * invalidate it (Ruling FP-4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@api/lib/definer', () => ({ getUserState: async () => null }));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => undefined }));

const { withIdentityTimeout, IDENTITY_LIVE_TIMEOUT_MS } = await import('@api/lib/identity-timeout');
const { accountStateCached, invalidateAccountState, resetLiveIdentityCache, LIVE_IDENTITY_TTL_MS } =
  await import('@api/lib/identity-live-cache');
const {
  configureIdentityClient,
  setAccountStatus,
  setAccountRole,
  revokeIdentityUser,
  updateIdentityProfile,
} = await import('@api/lib/identity-client');

beforeEach(() => resetLiveIdentityCache());
afterEach(() => {
  vi.useRealTimers();
  configureIdentityClient(undefined);
});

describe('withIdentityTimeout', () => {
  it('passes a fast answer through', async () => {
    await expect(withIdentityTimeout(Promise.resolve(7), 'x')).resolves.toBe(7);
  });

  it('a hanging RPC becomes a 503 IDENTITY_UNAVAILABLE at the budget, not a hang', async () => {
    vi.useFakeTimers();
    const p = withIdentityTimeout(new Promise(() => {}), 'getAccountState');
    const settled = expect(p).rejects.toMatchObject({
      statusCode: 503,
      code: 'IDENTITY_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(IDENTITY_LIVE_TIMEOUT_MS + 1);
    await settled;
  });

  it('the budget is 3 s', () => {
    expect(IDENTITY_LIVE_TIMEOUT_MS).toBe(3000);
  });
});

describe('accountStateCached', () => {
  const active = { status: 'active' };
  const positive = (v: { status: string } | null) => v?.status === 'active';

  it('6 concurrent requests for one account make ONE lookup (the dashboard burst)', async () => {
    const load = vi.fn(async () => active);
    await Promise.all(Array.from({ length: 6 }, () => accountStateCached('u1', load, positive)));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a positive answer is reused inside the window and re-asked after it', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => active);
    await accountStateCached('u1', load, positive);
    await accountStateCached('u1', load, positive);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LIVE_IDENTITY_TTL_MS + 1);
    await accountStateCached('u1', load, positive);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a suspended / unknown answer is never cached', async () => {
    const load = vi.fn(async () => ({ status: 'suspended' }));
    await accountStateCached('u1', load, positive);
    await accountStateCached('u1', load, positive);
    expect(load).toHaveBeenCalledTimes(2);
    const none = vi.fn(async () => null);
    await accountStateCached('u2', none, positive);
    await accountStateCached('u2', none, positive);
    expect(none).toHaveBeenCalledTimes(2);
  });

  it('a failed lookup is not cached and does not poison the next one', async () => {
    const load = vi
      .fn<() => Promise<{ status: string }>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(active);
    await expect(accountStateCached('u1', load, positive)).rejects.toThrow('down');
    await expect(accountStateCached('u1', load, positive)).resolves.toBe(active);
  });

  it('accounts do not share an entry', async () => {
    const load = vi.fn(async () => active);
    await accountStateCached('u1', load, positive);
    await accountStateCached('u2', load, positive);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidate drops the entry, and a lookup that was in flight is not stored afterwards', async () => {
    const load = vi.fn(async () => active);
    await accountStateCached('u1', load, positive);
    invalidateAccountState('u1');
    await accountStateCached('u1', load, positive);
    expect(load).toHaveBeenCalledTimes(2);

    const finishers: Array<(v: { status: string }) => void> = [];
    const slow = vi.fn(() => new Promise<{ status: string }>(r => finishers.push(r)));
    const pending = accountStateCached('u3', slow, positive);
    invalidateAccountState('u3'); // suspended while the lookup was running
    finishers[0](active);
    await pending;
    const again = accountStateCached('u3', slow, positive); // must ask again, not serve the pre-suspension answer
    finishers[1](active);
    await again;
    expect(slow).toHaveBeenCalledTimes(2);
  });
});

describe('the Store paths that change an account drop the cache (FP-4)', () => {
  const positive = (v: { status: string } | null) => v?.status === 'active';

  it.each([
    [
      'setAccountStatus',
      (f: ReturnType<typeof fakeRpc>) => setAccountStatus('u1', 'suspended', 'r'),
    ],
    ['setAccountRole', () => setAccountRole('u1', 'staff', 'r')],
    ['updateIdentityProfile', () => updateIdentityProfile('u1', { firstName: 'N' })],
    ['revokeIdentityUser', () => revokeIdentityUser('u1', 'r')],
  ])('%s invalidates, even when the call throws', async (_name, call) => {
    const rpc = fakeRpc();
    configureIdentityClient(rpc);
    const load = vi.fn(async () => ({ status: 'active' }));
    await accountStateCached('u1', load, positive);
    rpc.fail = true;
    await call(rpc).catch(() => undefined);
    await accountStateCached('u1', load, positive);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

function fakeRpc() {
  const state = { fail: false };
  const maybe = async () => {
    if (state.fail) throw new Error('down');
    return undefined;
  };
  return Object.assign(state, {
    setStatus: maybe,
    setRole: maybe,
    updateProfile: maybe,
    revokeUser: maybe,
  }) as never as {
    fail: boolean;
    setStatus: () => Promise<undefined>;
    setRole: () => Promise<undefined>;
    revokeUser: () => Promise<undefined>;
  };
}
