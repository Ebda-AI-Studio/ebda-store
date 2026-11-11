import { describe, it, expect } from 'vitest';
import { call } from './helpers';

// `/sign-in` still sends a person to the Store sign-in (Ruling ACCOUNTS-ENTRY-1). `/login` is this host's own sign-in page
// and the bare host lands on it, on the SAME host (Ruling ACCOUNTS-PAGE-1).
describe('GET entry paths', () => {
  it('/sign-in -> 302 store.ebda.app/login (unchanged)', async () => {
    const r = await call('/sign-in', { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://store.ebda.app/login');
  });
  it('/ -> 302 /login on accounts.ebda.app, never another host', async () => {
    const r = await call('/', { redirect: 'manual' });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!, 'https://accounts.ebda.app');
    expect(loc.href).toBe('https://accounts.ebda.app/login');
  });
  it('/login -> 200, the page itself', async () => {
    const r = await call('/login', { redirect: 'manual' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
  });
  it('the API login stays POST-only (a GET route never swallows it)', async () => {
    const r = await call('/login', { method: 'POST', json: { email: 'a@b.co', password: 'x' } });
    expect(r.status).not.toBe(302);
    expect(r.headers.get('content-type')).toContain('application/json');
  });
});
