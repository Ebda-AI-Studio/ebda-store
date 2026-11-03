import { describe, it, expect } from 'vitest';
import { call } from './helpers';

// Ebda Chat sends signed-out people to accounts.ebda.app/login?product=chat&return=<https://wa.ebda.app/...>.
// The bare entry used to drop both and send them to a Store page (ACCOUNTS-ENTRY-1); now the pair survives the hop
// (Ruling SIGNIN-RETURN-1). The admin /login is the boundary that validates `return`; this only keeps it intact.
describe('GET /login keeps product and return', () => {
  it('forwards both, URL-encoded', async () => {
    const r = await call(
      `/login?product=chat&return=${encodeURIComponent('https://wa.ebda.app/inbox?a=1&b=2')}`,
      { redirect: 'manual' }
    );
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://store.ebda.app/login');
    expect(loc.searchParams.get('product')).toBe('chat');
    expect(loc.searchParams.get('return')).toBe('https://wa.ebda.app/inbox?a=1&b=2');
  });

  it('an unknown product is dropped; the return still travels', async () => {
    const r = await call(`/login?product=crm&return=${encodeURIComponent('https://wa.ebda.app/')}`, {
      redirect: 'manual',
    });
    const loc = new URL(r.headers.get('location')!);
    expect(loc.searchParams.get('product')).toBeNull();
    expect(loc.searchParams.get('return')).toBe('https://wa.ebda.app/');
  });

  it('forwards nothing else, and nothing when absent', async () => {
    const r = await call('/login?evil=1&next=//x', { redirect: 'manual' });
    expect(r.headers.get('location')).toBe('https://store.ebda.app/login');
  });

  it('a non-https or oversized return is not forwarded', async () => {
    for (const bad of ['http://wa.ebda.app/', 'javascript:alert(1)', 'https://wa.ebda.app/' + 'a'.repeat(3000)]) {
      const r = await call(`/login?product=chat&return=${encodeURIComponent(bad)}`, { redirect: 'manual' });
      const loc = new URL(r.headers.get('location')!);
      expect(loc.searchParams.get('return'), bad.slice(0, 30)).toBeNull();
      expect(loc.searchParams.get('product')).toBe('chat');
    }
  });

  it('/ and /sign-in forward the same way', async () => {
    for (const p of ['/', '/sign-in']) {
      const r = await call(`${p}?product=chat`, { redirect: 'manual' });
      expect(new URL(r.headers.get('location')!).searchParams.get('product')).toBe('chat');
    }
  });
});
