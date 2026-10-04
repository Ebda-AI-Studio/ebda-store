/**
 * Per-merchant provider credentials (SP6a): encrypted at rest with the platform
 * key, decrypted only for one provider call, masked in every admin response, never
 * logged. Sandbox/live comes from the config's test flag.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@api/config', () => ({
  config: { encryptionKey: 'unit-test-encryption-key-32-characters-long' },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { encryption } from '@api/services/encryption.service';
import {
  describeForLog,
  modeOf,
  toProviderCredentials,
} from '@api/services/payment-providers/credentials';
import { maskCredentials, normalizeProviderSettings } from '@api/routes/payment-settings.routes';

const SECRET = 'sk_live_9f3a7c-SUPER-SECRET';
const row = (over: Record<string, unknown> = {}) => ({
  provider: 'paymob',
  apiKey: encryption.encrypt(SECRET),
  secretKey: encryption.encrypt('sec-key-value'),
  merchantId: encryption.encrypt('merchant-42'),
  webhookSecret: encryption.encrypt('whsec-123'),
  testMode: false,
  settings: { handle: 'amelia@instapay' },
  fixedFee: 500,
  ...over,
});

describe('provider credentials', () => {
  it('are stored encrypted and decrypt back for a call, with the mode and non-secret settings', () => {
    const r = row();
    expect(r.apiKey).not.toContain(SECRET);
    const creds = toProviderCredentials(r);
    expect(creds).toMatchObject({
      apiKey: SECRET,
      secretKey: 'sec-key-value',
      merchantId: 'merchant-42',
      webhookSecret: 'whsec-123',
      mode: 'live',
    });
    expect(creds.settings).toMatchObject({ handle: 'amelia@instapay', fixedFeeMinor: 500 });
  });

  it('sandbox vs live follows the config flag, per adapter', () => {
    expect(modeOf({ testMode: true })).toBe('sandbox');
    expect(modeOf({ testMode: false })).toBe('live');
    expect(toProviderCredentials(row({ testMode: true })).mode).toBe('sandbox');
  });

  it('missing optional credentials are simply absent', () => {
    const creds = toProviderCredentials(
      row({ secretKey: null, merchantId: null, webhookSecret: null })
    );
    expect(creds.secretKey).toBeUndefined();
    expect(creds.webhookSecret).toBeUndefined();
  });

  it('the admin view is masked: no plaintext, no ciphertext, only the save-time fingerprint', () => {
    const r = row();
    const masked = maskCredentials({ ...r, apiKeyLast4: 'CRET', merchantIdLast4: 'it-42' });
    const dump = JSON.stringify(masked);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(r.apiKey);
    expect(dump).not.toContain(r.secretKey);
    expect(dump).not.toContain(r.webhookSecret);
    expect(masked.apiKey).toBe('****CRET');
    expect(masked.secretKey).toBe('****');
    expect(masked.webhookSecret).toBe('****');
  });

  it('what may be logged about a config carries no secret and no fingerprint', () => {
    const logged = JSON.stringify(describeForLog(row()));
    for (const leak of [SECRET, 'sec-key-value', 'merchant-42', 'whsec-123', 'CRET']) {
      expect(logged).not.toContain(leak);
    }
    expect(JSON.parse(logged)).toMatchObject({
      provider: 'paymob',
      mode: 'live',
      hasApiKey: true,
    });
  });
});

describe('normalizeProviderSettings', () => {
  it('InstaPay: enabling needs a handle or phone; a disabled draft may be partial', () => {
    expect(() => normalizeProviderSettings('instapay', {}, true)).toThrow(/handle/i);
    expect(normalizeProviderSettings('instapay', { accountName: 'A' }, false)).toMatchObject({
      accountName: 'A',
    });
    expect(
      normalizeProviderSettings('instapay', { handle: 'amelia@instapay' }, true)
    ).toMatchObject({
      handle: 'amelia@instapay',
      expiryHours: 48,
    });
  });

  it('drops unknown keys (nothing arbitrary is persisted), gateways included', () => {
    const out = normalizeProviderSettings('instapay', { handle: 'a1@instapay', evil: '<x>' }, true);
    expect(out).not.toHaveProperty('evil');
    expect(normalizeProviderSettings('paymob', { anything: 1 }, false)).not.toHaveProperty(
      'anything'
    );
    expect(normalizeProviderSettings('kashier', { anything: 1 }, true)).not.toHaveProperty(
      'anything'
    );
    // Providers with no settings at all (COD fee aside) persist nothing.
    expect(normalizeProviderSettings('unknown-gw', { anything: 1 }, true)).toEqual({});
  });

  it('COD: a percentage in basis points', () => {
    expect(normalizeProviderSettings('cod', { percentBps: 150 }, true)).toEqual({
      percentBps: 150,
    });
    expect(() => normalizeProviderSettings('cod', { percentBps: 9_999 }, true)).toThrow();
  });
});
