import { describe, it, expect } from 'vitest';
import { call } from './helpers';

// `/sign-in` still hops to the Store sign-in (ACCOUNTS-ENTRY-1) and keeps product + return (Ruling SIGNIN-RETURN-1).
// The admin /login is the boundary that validates `return`; this only keeps it intact. (`/login` and `/` are the
// accounts page now, Ruling ACCOUNTS-PAGE-1: test/sign-in-page.test.ts.)
describe('GET /sign-in keeps product and return', () => {
  it('forwards both, URL-encoded', async () => {
    const r = await call(
      `/sign-in?product=chat&return=${encodeURIComponent('https://wa.ebda.app/inbox?a=1&b=2')}`,
      { redirect: 'manual' }
    );
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://store.ebda.app/login');
    expect(loc.searchParams.get('product')).toBe('chat');
    expect(loc.searchParams.get('return')).toBe('https://wa.ebda.app/inbox?a=1&b=2');
  });

  it('an unknown product is dropped; the return still travels', async () => {
    const r = await call(
      `/sign-in?product=crm&return=${encodeURIComponent('https://wa.ebda.app/')}`,
      {
        redirect: 'manual',
      }
    );
    const loc = new URL(r.headers.get('location')!);
    expect(loc.searchParams.get('product')).toBeNull();
    expect(loc.searchParams.get('return')).toBe('https://wa.ebda.app/');
  });

  it('forwards nothing else, and nothing when absent', async () => {
    const r = await call('/sign-in?evil=1&next=//x', { redirect: 'manual' });
    expect(r.headers.get('location')).toBe('https://store.ebda.app/login');
  });

  it('a non-https or oversized return is not forwarded', async () => {
    for (const bad of [
      'http://wa.ebda.app/',
      'javascript:alert(1)',
      'https://wa.ebda.app/' + 'a'.repeat(3000),
    ]) {
      const r = await call(`/sign-in?product=chat&return=${encodeURIComponent(bad)}`, {
        redirect: 'manual',
      });
      const loc = new URL(r.headers.get('location')!);
      expect(loc.searchParams.get('return'), bad.slice(0, 30)).toBeNull();
      expect(loc.searchParams.get('product')).toBe('chat');
    }
  });

  it("/ keeps them on the way to this host's /login", async () => {
    const r = await call(
      `/?product=chat&return=${encodeURIComponent('https://wa.ebda.app/x')}&evil=1`,
      {
        redirect: 'manual',
      }
    );
    const loc = new URL(r.headers.get('location')!, 'https://accounts.ebda.app');
    expect(loc.origin + loc.pathname).toBe('https://accounts.ebda.app/login');
    expect(loc.searchParams.get('product')).toBe('chat');
    expect(loc.searchParams.get('return')).toBe('https://wa.ebda.app/x');
    expect(loc.searchParams.get('evil')).toBeNull();
  });
});
