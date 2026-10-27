import { describe, expect, it } from 'vitest';
import { accessToken, api, authState } from './helpers';

const uid = () => crypto.randomUUID();
const session = (token: string) =>
  api.fetch('https://api.ebda.app/api/v1/realtime/session', {
    headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '10.1.1.1' },
  });

describe('AuthState durable object: revocation holds across requests', () => {
  it('a revoked jti is rejected on the very next request, and a live one is accepted', async () => {
    const userId = uid();
    const jti = uid();
    // A warm token-version cache, so the request needs no database (a miss reads Postgres).
    await authState(`user:tv:${userId}`, [['set', `user:tv:${userId}`, '0', {}]]);
    const token = await accessToken({ userId, jti });

    const before = await session(token);
    expect(before.status).toBe(200);
    expect(((await before.json()) as { data: { userId: string } }).data.userId).toBe(userId);

    // Revoke from another request path entirely (what logout does): denylist the jti.
    await authState(`jti:deny:${jti}`, [['set', `jti:deny:${jti}`, '1', { ttlMs: 60_000 }]]);

    const after = await session(token);
    expect(after.status).toBe(401);
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe('TOKEN_REVOKED');
  });

  it('a bumped token version revokes every older token of the user at once', async () => {
    const userId = uid();
    await authState(`user:tv:${userId}`, [['set', `user:tv:${userId}`, '0', {}]]);
    const old = await accessToken({ userId, jti: uid(), tv: 0 });
    expect((await session(old)).status).toBe(200);

    await authState(`user:tv:${userId}`, [['set', `user:tv:${userId}`, '1', {}]]);
    const res = await session(old);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TOKEN_REVOKED');
    // ...and a token minted at the new version is fine.
    expect((await session(await accessToken({ userId, jti: uid(), tv: 1 }))).status).toBe(200);
  });

  it('a denied jti expires with its TTL', async () => {
    const key = `jti:deny:${uid()}`;
    // Virtual clock (the store's `nowMs`): a 150 ms TTL checked "right after" the write flaked when a loaded
    // runner took longer than that between the two calls (Ruling FLAKE-LEASE-1).
    const T0 = 2_000_000;
    await authState(key, [['set', key, '1', { ttlMs: 150 }]], T0);
    expect((await authState(key, [['exists', key]], T0 + 149))[0]).toBe(1);
    expect((await authState(key, [['exists', key]], T0 + 151))[0]).toBe(0);
  });

  it('SET NX is a mutex: of 25 parallel claims exactly one wins', async () => {
    const key = `lock:${uid()}`;
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        authState(key, [['set', key, 'x', { nx: true, ttlMs: 5000 }]])
      )
    );
    expect(results.filter(r => r[0] === 'OK')).toHaveLength(1);
  });

  it('INCR is atomic: 50 parallel increments return 50 distinct values 1..50', async () => {
    const key = `lockout:${uid()}:attempts`;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => authState(key, [['incr', key]]))
    );
    const values = results.map(r => r[0] as number).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('lockout counters of one account share a shard (attempts / locked / row)', async () => {
    const { shardOf } = await import('../src/cf/auth-state-client');
    const id = `lockout:${uid()}@example.com`;
    expect(shardOf(`${id}:attempts`)).toBe(shardOf(`${id}:locked`));
    expect(shardOf(`${id}:attempts`)).toBe(shardOf(id));
  });

  it('lists back the dead-letter pages: LPUSH / RPOP are FIFO and LRANGE is newest first', async () => {
    const key = `email:failed:${uid()}`;
    await authState(key, [
      ['lpush', key, 'a'],
      ['lpush', key, 'b'],
      ['lpush', key, 'c'],
    ]);
    expect((await authState(key, [['llen', key]]))[0]).toBe(3);
    expect((await authState(key, [['lrange', key, 0, -1]]))[0]).toEqual(['c', 'b', 'a']);
    expect((await authState(key, [['rpop', key]]))[0]).toBe('a');
    await authState(key, [['ltrim', key, 0, 0]]);
    expect((await authState(key, [['lrange', key, 0, -1]]))[0]).toEqual(['c']);
  });
});
