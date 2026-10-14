import { describe, it, expect } from 'vitest';
import { assertLocalOnly, isLocalHostname, orderBelongsToRun } from '../smoke/commerce-b0.guards';

describe('commerce-b0 spec guards', () => {
  it('accepts only local hosts', () => {
    for (const u of [
      'http://127.0.0.1:4100/api/v1',
      'http://localhost:3100',
      'http://b0-minimal.localhost:3100',
      'http://[::1]:4100/api/v1',
    ]) {
      expect(() => assertLocalOnly({ B0_API_URL: u })).not.toThrow();
    }
  });

  it('refuses deployed and look-alike hosts, with no override', () => {
    for (const u of [
      'https://api.ebda.app',
      'https://ebda.app',
      'https://demo-shop.example',
      'http://localhost.evil.com',
      'http://evil.com/.localhost',
      'http://127.0.0.1.nip.io',
      'not a url',
    ]) {
      expect(() => assertLocalOnly({ B0_API_URL: u }), u).toThrow(/commerce-b0/);
    }
    process.env.B0_ALLOW_REMOTE = '1';
    expect(() => assertLocalOnly({ B0_API_URL: 'https://api.ebda.app' })).toThrow();
    delete process.env.B0_ALLOW_REMOTE;
  });

  it('checks every url, so one local url cannot excuse a remote one', () => {
    expect(() =>
      assertLocalOnly({
        B0_WEB_URL: 'http://b0-minimal.localhost:3100',
        B0_API_URL: 'https://api.ebda.app',
      })
    ).toThrow(/B0_API_URL/);
  });

  it('isLocalHostname is case-insensitive', () => {
    expect(isLocalHostname('B0.LOCALHOST')).toBe(true);
    expect(isLocalHostname('example.com')).toBe(false);
  });

  it('only an order with this run email may be touched', () => {
    const mine = { shippingAddress: { email: 'B0-E2E-1@example.test ' } };
    const theirs = { shippingAddress: { email: 'customer@shop.com' } };
    expect(orderBelongsToRun(mine, 'b0-e2e-1@example.test')).toBe(true);
    expect(orderBelongsToRun(theirs, 'b0-e2e-1@example.test')).toBe(false);
    expect(orderBelongsToRun({}, 'b0-e2e-1@example.test')).toBe(false);
    expect(orderBelongsToRun(null, 'b0-e2e-1@example.test')).toBe(false);
  });
});
