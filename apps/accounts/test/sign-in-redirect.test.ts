import { describe, it, expect } from 'vitest';
import { call } from './helpers';

// accounts.ebda.app is API-only: the sign-in form lives in the Store app (store.ebda.app/login), which posts to this service.
// A person who types the bare host, /login or /sign-in must land there, not on a 404 (Ruling ACCOUNTS-ENTRY-1).
describe('GET entry paths send a person to the Store sign-in', () => {
  for (const path of ['/', '/login', '/sign-in']) {
    it(`${path} -> 302 store.ebda.app/login`, async () => {
      const r = await call(path, { redirect: 'manual' });
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe('https://store.ebda.app/login');
    });
  }
  it('the API login stays POST-only (a GET redirect never swallows it)', async () => {
    const r = await call('/login', { method: 'POST', json: { email: 'a@b.co', password: 'x' } });
    expect(r.status).not.toBe(302);
  });
});
