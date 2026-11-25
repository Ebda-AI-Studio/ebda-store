/**
 * G71: a guest's `GET /auth/me?probe=guest` is answered 200 `{ user: null }` (no red 401 in the console),
 * while ANY credential, or a request without the probe flag, still reaches `authenticate` (401 -> refresh flow intact).
 */
import { describe, it, expect, vi } from 'vitest';
import { guestProbe } from '@api/middleware/guest-probe';

function run(req: Record<string, unknown>) {
  const res = { json: vi.fn() };
  const next = vi.fn();
  guestProbe(req as never, res as never, next);
  return { res, next };
}

describe('guestProbe', () => {
  it('answers 200 { user: null } for a credential-less probe', () => {
    const { res, next } = run({ query: { probe: 'guest' }, cookies: {}, headers: {} });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { user: null } });
    expect(next).not.toHaveBeenCalled();
  });
  it.each([
    ['access cookie', { cookies: { token: 't' }, headers: {} }],
    ['refresh cookie', { cookies: { refresh_token: 'r' }, headers: {} }],
    ['bearer header', { cookies: {}, headers: { authorization: 'Bearer x' } }],
    ['unparsed cookies', { cookies: undefined, headers: {} }],
  ])('falls through to authenticate with a %s', (_n, extra) => {
    const { res, next } = run({ query: { probe: 'guest' }, ...extra });
    expect(next).toHaveBeenCalledOnce();
    expect(res.json).not.toHaveBeenCalled();
  });
  it('falls through without the probe flag (plain /auth/me stays a 401 for a guest)', () => {
    const { res, next } = run({ query: {}, cookies: {}, headers: {} });
    expect(next).toHaveBeenCalledOnce();
    expect(res.json).not.toHaveBeenCalled();
  });
});
