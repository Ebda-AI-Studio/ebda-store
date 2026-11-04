import { describe, expect, it } from 'vitest';
import { accessToken, api, authState } from './helpers';

const uid = () => crypto.randomUUID();
const session = (token: string) =>
  api.fetch('https://api.ebda.app/api/v1/realtime/session', {
    headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '10.2.2.2' },
  });

/**
 * BE:S-2 on the real runtime. `AsyncLocalStorage.enterWith` is not implemented on workerd, so a version of `authenticate` that used
 * it turned every impersonated request into 401 TOKEN_INVALID (support impersonation dead, no `impersonatedBy` in any audit row).
 * Node unit tests cannot see that; this runs the built Worker.
 */
describe('an impersonated token authenticates on workerd', () => {
  it('is accepted (not 401) and the impersonator is in the request scope', async () => {
    const userId = uid();
    await authState(`user:tv:${userId}`, [['set', `user:tv:${userId}`, '0', {}]]);
    const token = await accessToken({ userId, jti: uid(), impersonatedBy: 'super-admin-1' });

    const res = await session(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { userId: string; impersonatedBy: string | null } };
    expect(body.data.userId).toBe(userId);
    expect(body.data.impersonatedBy).toBe('super-admin-1');
  });

  it('an ordinary token has no impersonator in scope', async () => {
    const userId = uid();
    await authState(`user:tv:${userId}`, [['set', `user:tv:${userId}`, '0', {}]]);
    const res = await session(await accessToken({ userId, jti: uid() }));
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { impersonatedBy: string | null } }).data.impersonatedBy
    ).toBeNull();
  });
});
