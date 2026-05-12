import { describe, it, expect, vi } from 'vitest';

// email.service now imports @force/database at the module level;
// mock it so this unit test doesn't require a generated prisma client.
vi.mock('@force/database', () => ({
  prisma: { store: { findUnique: vi.fn() } },
}));

import { renderBrandedShell, type EmailStoreContext } from '@api/services/email.service';

const baseStore = (overrides: Partial<EmailStoreContext> = {}): EmailStoreContext => ({
  name: 'Wady Aljuz',
  logo: null,
  theme: null,
  email: null,
  phone: null,
  address: null,
  defaultLanguage: 'en',
  ...overrides,
});

describe('renderBrandedShell', () => {
  it('uses store name in header when no logo', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore());
    expect(html).toContain('<h1>Wady Aljuz</h1>');
    expect(html).toContain('© ' + new Date().getFullYear() + ' Wady Aljuz');
  });

  it('renders logo img when logo url present', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ logo: 'https://r2.dev/logo.png' }));
    expect(html).toContain('<img src="https://r2.dev/logo.png"');
    expect(html).not.toContain('<h1>Wady Aljuz</h1>');
  });

  it('uses store theme primary color when set (hex)', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ theme: { primary: '#2D1418' } }));
    expect(html).toContain('background: #2D1418');
  });

  it('falls back to platform orange when theme color is invalid', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ theme: { primary: 'rm -rf /' } }));
    expect(html).toContain('background: #ff6e00');
  });

  it('renders RTL when defaultLanguage is ar', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ defaultLanguage: 'ar' }));
    expect(html).toContain('dir="rtl"');
  });

  it('includes powered-by line in footer', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore());
    expect(html).toContain('Powered by Force Store');
  });

  it('escapes the store name to prevent XSS in header', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ name: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
