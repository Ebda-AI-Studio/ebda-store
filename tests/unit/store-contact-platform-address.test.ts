import { describe, expect, it } from 'vitest';
import { isPlatformAddress } from '../../apps/api/src/services/store-contact.service';

// FU46 M-5 / N-2: shopper contact messages must never be mailed to Ebda itself — any mailbox on
// Ebda's domain (or a subdomain), not only the three named brand addresses.
describe('isPlatformAddress', () => {
  it('treats every mailbox on the platform domain as the platform', () => {
    expect(isPlatformAddress('no-reply@ebda.app')).toBe(true);
    expect(isPlatformAddress('sales@ebda.app')).toBe(true);
    expect(isPlatformAddress('  Ops@EBDA.app ')).toBe(true);
    expect(isPlatformAddress('team@mail.ebda.app')).toBe(true);
  });

  it('keeps store-owned addresses, including look-alike domains', () => {
    expect(isPlatformAddress('owner@gmail.com')).toBe(false);
    expect(isPlatformAddress('shop@myebda.app')).toBe(false);
    expect(isPlatformAddress('shop@ebda.app.example.com')).toBe(false);
  });
});
