/**
 * Ruling CONSENT-ADMIN-1: an owner who never accepted the Terms and Privacy policy can read but not write,
 * enforced in `authenticate` (server-side), not only by the admin modal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { consentGiven } = vi.hoisted(() => ({ consentGiven: vi.fn() }));
vi.mock('@api/lib/owner-consent', async importOriginal => {
  const real = await importOriginal<typeof import('@api/lib/owner-consent')>();
  return { ...real, consentGiven, ownerConsentGateEnabled: () => true };
});

import { enforceOwnerConsent } from '@api/middleware/auth';
import { isGatedRequest } from '@api/lib/owner-consent';

const req = (method: string, originalUrl: string) => ({ method, originalUrl }) as never;
const owner = { userId: 'u1', role: 'store_admin' };

beforeEach(() => consentGiven.mockReset());

describe('owner consent gate', () => {
  it('an owner with NO acceptance record is refused on an admin write with 403 CONSENT_REQUIRED', async () => {
    consentGiven.mockResolvedValue(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expect(
        enforceOwnerConsent(req(m, '/api/v1/stores/s1/products'), owner)
      ).rejects.toMatchObject({ statusCode: 403, code: 'CONSENT_REQUIRED' });
    }
  });

  it('after accepting, the same write is allowed', async () => {
    consentGiven.mockResolvedValue(true);
    await expect(
      enforceOwnerConsent(req('POST', '/api/v1/stores/s1/products'), owner)
    ).resolves.toBeUndefined();
  });

  it('reads, login/MFA and the consent endpoints themselves are never gated', async () => {
    consentGiven.mockResolvedValue(false);
    await expect(
      enforceOwnerConsent(req('GET', '/api/v1/stores/s1/orders'), owner)
    ).resolves.toBeUndefined();
    for (const url of [
      '/api/v1/auth/logout',
      '/api/v1/auth/mfa/verify',
      '/api/v1/me/legal-notices/accept',
      '/api/v1/me/legal-notices/ack?x=1',
    ]) {
      await expect(enforceOwnerConsent(req('POST', url), owner)).resolves.toBeUndefined();
    }
    expect(consentGiven).not.toHaveBeenCalled();
  });

  it('only owners are gated: staff, super admin, customers and impersonation are not', async () => {
    consentGiven.mockResolvedValue(false);
    for (const u of [
      { userId: 's', role: 'staff' },
      { userId: 'a', role: 'super_admin' },
      { userId: 'c', role: 'customer' },
      { userId: 'u1', role: 'store_admin', impersonatedBy: 'admin1' },
    ]) {
      await expect(
        enforceOwnerConsent(req('POST', '/api/v1/stores/s1/products'), u)
      ).resolves.toBeUndefined();
    }
  });

  it('isGatedRequest ignores the query string and covers writes only', () => {
    expect(isGatedRequest('POST', '/api/v1/stores/s1/orders?x=/api/v1/auth')).toBe(true);
    expect(isGatedRequest('HEAD', '/api/v1/stores/s1/orders')).toBe(false);
    expect(isGatedRequest('POST', '/api/v1/authority')).toBe(true);
  });

  it('the gate is on outside tests and can be switched off or forced on', async () => {
    const { ownerConsentGateEnabled } =
      await vi.importActual<typeof import('@api/lib/owner-consent')>('@api/lib/owner-consent');
    expect(ownerConsentGateEnabled({ NODE_ENV: 'production' } as never)).toBe(true);
    expect(ownerConsentGateEnabled({ NODE_ENV: 'test' } as never)).toBe(false);
    expect(ownerConsentGateEnabled({ NODE_ENV: 'test', OWNER_CONSENT_GATE: '1' } as never)).toBe(
      true
    );
    expect(
      ownerConsentGateEnabled({ NODE_ENV: 'production', OWNER_CONSENT_GATE: '0' } as never)
    ).toBe(false);
  });

  it('wiring: both authenticate branches (identity token and legacy HS256) call the gate', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('apps/api/src/middleware/auth.ts', 'utf8');
    expect(src).toMatch(/await enforceOwnerConsent\(req, user\);/);
    expect(src).toMatch(/await enforceOwnerConsent\(req, payload\);/);
  });
});
