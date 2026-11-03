/** P0 logout audit: the socket takes a fresh token from the auth source before every (re)connect, and stops on revoke. */
import { describe, it, expect, vi } from 'vitest';
import { makeSocketAuth } from './socket-auth';

describe('makeSocketAuth', () => {
  it('hands the fresh token to the handshake on every connect (not localStorage.accessToken)', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('t1').mockResolvedValueOnce('t2');
    const auth = makeSocketAuth({ getToken, onRevoked: vi.fn() });
    const cb = vi.fn();
    await auth(cb);
    await auth(cb);
    expect(cb).toHaveBeenNthCalledWith(1, { token: 't1' });
    expect(cb).toHaveBeenNthCalledWith(2, { token: 't2' });
  });

  it('on a revoked session: stops reconnecting and reports it once', async () => {
    const onRevoked = vi.fn();
    const auth = makeSocketAuth({ getToken: vi.fn().mockResolvedValue(null), onRevoked });
    const cb = vi.fn();
    await auth(cb);
    await auth(cb);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({});
  });

  it('a throttled refresh is not a revoke: connect with no token, keep trying later', async () => {
    const onRevoked = vi.fn();
    const auth = makeSocketAuth({
      getToken: vi.fn().mockRejectedValue(new Error('throttled')),
      onRevoked,
    });
    const cb = vi.fn();
    await auth(cb);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({});
  });
});
