/**
 * Provider catalog + "connect a provider" framework (Batch 0, rulings PROVIDERS-1/2):
 * catalog invariants, the encrypted per-mode credential blob, write-only views, the
 * connection-test fingerprint and the enable gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BRAND,
  PAYMENT_PROVIDER_CODES,
  PROVIDER_CATALOG,
  getProviderEntry,
  providerRequestMailto,
  validateCredentialValue,
} from '@force/shared';
import {
  bindCredentialFields,
  connectionFingerprint,
  decryptCredentialBlob,
  encryptCredentialBlob,
  hintsFor,
  toProviderCredentials,
} from '@api/services/payment-providers/credentials';
import {
  applyCredentialUpdate,
  assertEnableAllowed,
  connectionTestIsCurrent,
  publicPaymentConfig,
  runConnectionTest,
} from '@api/services/payment-providers/provider-connection.service';
import { isProviderUsable } from '@api/services/payment-providers/provider-gate';
import { getProviderV2 } from '@api/services/payment-providers/registry';
import { GATEWAY_WEBHOOK_PROVIDERS } from '@api/services/payment-providers/webhook-signature';

const OFFICIAL_HOSTS = [
  'developers.paymob.com',
  'accept.paymob.com',
  'developers.kashier.io',
  'merchant.kashier.io',
  'developer.fawrystaging.com',
  'atfawry.fawrystaging.com',
];

const paymob = getProviderEntry('paymob')!;
const kashier = getProviderEntry('kashier')!;

describe('provider catalog', () => {
  it('lists exactly the supported payment providers (Ahmad, 2026-10-07)', () => {
    expect([...PAYMENT_PROVIDER_CODES].sort()).toEqual(
      ['cod', 'fawry', 'instapay', 'kashier', 'paymob'].sort()
    );
    const codes = PROVIDER_CATALOG.map(p => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every gateway has an adapter with a connection test and webhook wiring', () => {
    const gateways = PROVIDER_CATALOG.filter(p => p.kind === 'payments' && !p.manual);
    for (const g of gateways) {
      expect(getProviderV2(g.code)?.testConnection, g.code).toBeTypeOf('function');
    }
    expect([...GATEWAY_WEBHOOK_PROVIDERS].sort()).toEqual(gateways.map(g => g.code).sort());
  });

  it('verified=true only with recorded sandbox evidence (PROVIDERS-2)', () => {
    for (const p of PROVIDER_CATALOG.filter(e => !e.manual)) {
      if (p.verified)
        expect(p.verification.sandboxVerifiedAt, p.code).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
    // Today nothing has run against a real sandbox.
    expect(PROVIDER_CATALOG.filter(p => !p.manual && p.verified)).toEqual([]);
  });

  it('every field is bilingual, binds to a real slot, and links only to official pages', () => {
    for (const p of PROVIDER_CATALOG) {
      const keys = p.fields.map(f => f.key);
      expect(new Set(keys).size, p.code).toBe(keys.length);
      for (const f of p.fields) {
        for (const t of [f.label, f.help, f.whereToFind]) {
          expect(t.en.length, `${p.code}.${f.key}`).toBeGreaterThan(0);
          expect(t.ar.length, `${p.code}.${f.key}`).toBeGreaterThan(0);
        }
        expect(f.bind).toMatch(
          /^(apiKey|secretKey|merchantId|webhookSecret|settings\.[a-zA-Z.]+)$/
        );
        if (f.pattern) expect(() => new RegExp(f.pattern!)).not.toThrow();
      }
      for (const url of Object.values(p.docs).filter(Boolean)) {
        expect(OFFICIAL_HOSTS, `${p.code} ${url}`).toContain(new URL(url as string).host);
      }
    }
  });

  it('no two fields of a provider bind the same slot', () => {
    for (const p of PROVIDER_CATALOG) {
      const binds = p.fields.map(f => f.bind);
      expect(new Set(binds).size, p.code).toBe(binds.length);
    }
  });

  it('"need another provider" mails the brand support address with a subject', () => {
    const href = providerRequestMailto(BRAND.supportEmail, 'payments');
    expect(href.startsWith(`mailto:${BRAND.supportEmail}?subject=`)).toBe(true);
  });

  it('validates values per field (pattern, integer, control characters)', () => {
    const mid = kashier.fields.find(f => f.key === 'merchantId')!;
    expect(validateCredentialValue(mid, 'MID-12-345')).toBeNull();
    expect(validateCredentialValue(mid, 'MID-x')).not.toBeNull();
    const card = paymob.fields.find(f => f.key === 'integrationId.card')!;
    expect(validateCredentialValue(card, '4097558')).toBeNull();
    expect(validateCredentialValue(card, '12a')).not.toBeNull();
    expect(validateCredentialValue(mid, 'MID-1-1\n')).toBeNull(); // trimmed
    expect(validateCredentialValue(mid, 'MID-1\u0000-1')).not.toBeNull();
  });
});

describe('PROVIDERS-2 gate', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = saved.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    process.env.NODE_ENV = saved.NODE_ENV;
  });

  it('an unverified gateway is not usable; manual methods always are', () => {
    delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    expect(isProviderUsable('paymob')).toBe(false);
    expect(isProviderUsable('kashier')).toBe(false);
    expect(isProviderUsable('fawry')).toBe(false);
    expect(isProviderUsable('cod')).toBe(true);
    expect(isProviderUsable('instapay')).toBe(true);
    expect(isProviderUsable('geidea')).toBe(false);
  });

  it('the stub seam is ignored in production', () => {
    process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = '1';
    process.env.NODE_ENV = 'production';
    expect(isProviderUsable('paymob')).toBe(false);
    process.env.NODE_ENV = 'test';
    expect(isProviderUsable('paymob')).toBe(true);
  });
});

describe('credential blob: encrypted, per mode, write-only', () => {
  const fields = {
    merchantId: 'MID-12-345',
    paymentApiKey: 'pak_live_0123456789abcdef',
    secretKey: 'abcdef0123456789$secretsecret',
  };

  it('round-trips through AES-GCM and never stores plaintext', () => {
    const cipher = encryptCredentialBlob({ sandbox: fields });
    expect(cipher).not.toContain(fields.secretKey);
    expect(decryptCredentialBlob(cipher)).toEqual({ sandbox: fields });
  });

  it('hints show last 4 of a long secret, the value of a public field, never a secret', () => {
    const hints = hintsFor(kashier, { sandbox: fields });
    expect(hints.sandbox!.secretKey).toEqual({ set: true, last4: 'cret' });
    expect(hints.sandbox!.merchantId).toEqual({ set: true, value: 'MID-12-345' });
    expect(JSON.stringify(hints)).not.toContain(fields.secretKey);
    expect(JSON.stringify(hints)).not.toContain(fields.paymentApiKey);
    // A short secret shows "saved" only.
    const short = hintsFor(kashier, { live: { secretKey: 'short' } });
    expect(short.live!.secretKey).toEqual({ set: true });
  });

  it('binds catalog fields onto the adapter slots, per mode', () => {
    const c = bindCredentialFields(
      paymob,
      {
        secretKey: 'sk_test_x',
        apiKey: 'api-key',
        hmacSecret: 'hmac',
        publicKey: 'pk_test_y',
        'integrationId.card': '11',
        'integrationId.wallet': '22',
      },
      'sandbox',
      {}
    );
    expect(c).toMatchObject({
      apiKey: 'sk_test_x',
      secretKey: 'api-key',
      webhookSecret: 'hmac',
      mode: 'sandbox',
      settings: { publicKey: 'pk_test_y', integrationIds: { card: 11, wallet: 22 } },
    });
  });

  it('toProviderCredentials reads the ACTIVE mode only; a sandbox key never reaches live', () => {
    const cipher = encryptCredentialBlob({
      sandbox: { ...fields, secretKey: 'sandbox-secret' },
      live: { ...fields, secretKey: 'live-secret' },
    });
    const row = { provider: 'kashier', credentials: cipher, settings: {} };
    expect(toProviderCredentials({ ...row, testMode: true }).secretKey).toBe('sandbox-secret');
    expect(toProviderCredentials({ ...row, testMode: false }).secretKey).toBe('live-secret');
    expect(toProviderCredentials({ ...row, testMode: false }).mode).toBe('live');
  });

  it('updates: masked echo and empty keep, null clears, bad values and unknown keys are refused', () => {
    const first = applyCredentialUpdate(kashier, null, { mode: 'sandbox', fields });
    expect(first.changed.sort()).toEqual(['merchantId', 'paymentApiKey', 'secretKey']);
    const row = { credentials: first.cipher, testMode: true };
    const keep = applyCredentialUpdate(kashier, row, {
      mode: 'sandbox',
      fields: { secretKey: '****cret', paymentApiKey: '' },
    });
    expect(keep.changed).toEqual([]);
    expect(decryptCredentialBlob(keep.cipher).sandbox!.secretKey).toBe(fields.secretKey);
    const cleared = applyCredentialUpdate(kashier, row, {
      mode: 'sandbox',
      fields: { secretKey: null },
    });
    expect(decryptCredentialBlob(cleared.cipher).sandbox!.secretKey).toBeUndefined();
    expect(() =>
      applyCredentialUpdate(kashier, row, { mode: 'sandbox', fields: { merchantId: 'nope' } })
    ).toThrow(/merchantId/);
    expect(() =>
      applyCredentialUpdate(kashier, row, { mode: 'sandbox', fields: { password: 'x' } })
    ).toThrow(/not a kashier credential/);
    // Editing the INACTIVE mode does not touch the active credentials.
    const liveEdit = applyCredentialUpdate(kashier, row, { mode: 'live', fields });
    expect(liveEdit.activeModeChanged).toBe(false);
  });

  it('the browser view drops ciphertext, legacy secret columns and the fingerprint', () => {
    const view = publicPaymentConfig(
      {
        provider: 'kashier',
        credentials: 'CIPHER',
        apiKey: 'enc-a',
        secretKey: 'enc-b',
        merchantId: 'enc-c',
        webhookSecret: 'enc-d',
        testMode: true,
        isEnabled: false,
        connectionTest: {
          ok: true,
          code: 'ok',
          mode: 'sandbox',
          at: 'x',
          fingerprint: 'fp-secret',
        },
      },
      '11111111-1111-1111-1111-111111111111'
    );
    const json = JSON.stringify(view);
    for (const leaked of ['CIPHER', 'enc-a', 'enc-b', 'enc-c', 'enc-d', 'fp-secret']) {
      expect(json).not.toContain(leaked);
    }
    expect(view.webhookUrl).toMatch(/\/webhooks\/payment\/kashier\/s\/1111/);
  });
});

describe('enable gate: a passing test of EXACTLY the stored credentials', () => {
  const fields = {
    merchantId: 'MID-12-345',
    paymentApiKey: 'pak_test_0123456789abcdef',
    secretKey: 'abcdef0123456789$secretsecret',
  };
  const cipher = encryptCredentialBlob({ sandbox: fields });
  const okTest = {
    ok: true,
    code: 'ok',
    mode: 'sandbox',
    at: new Date().toISOString(),
    fingerprint: connectionFingerprint('kashier', 'sandbox', fields),
  };
  const row = (over: Record<string, unknown> = {}) => ({
    provider: 'kashier',
    testMode: true,
    isEnabled: false,
    credentials: cipher,
    connectionTest: okTest,
    ...over,
  });

  beforeEach(() => {
    process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = '1';
  });
  afterEach(() => {
    process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = '1';
  });

  it('passes for a current successful test', () => {
    expect(connectionTestIsCurrent(row())).toBe(true);
    expect(() => assertEnableAllowed(row())).not.toThrow();
  });

  it('refuses: no test, a failed test, edited credentials, another mode, a forged fingerprint', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['no test', { connectionTest: null }],
      ['failed test', { connectionTest: { ...okTest, ok: false, fingerprint: null } }],
      [
        'edited secret',
        {
          credentials: encryptCredentialBlob({
            sandbox: { ...fields, secretKey: 'other-secret-value-1234' },
          }),
        },
      ],
      ['switched to live', { testMode: false }],
      ['forged fingerprint', { connectionTest: { ...okTest, fingerprint: 'f'.repeat(64) } }],
      ['no credentials', { credentials: null }],
    ];
    for (const [name, over] of cases) {
      expect(() => assertEnableAllowed(row(over)), name).toThrow(/Test connection/);
    }
  });

  it('refuses an unverified provider even with a current test (PROVIDERS-2)', () => {
    delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    expect(() => assertEnableAllowed(row())).toThrow(/coming soon/);
  });

  it('manual methods are not gated', () => {
    expect(() =>
      assertEnableAllowed({ provider: 'cod', testMode: false, isEnabled: true })
    ).not.toThrow();
  });

  it('an incomplete set is reported without calling the gateway', async () => {
    const partial = encryptCredentialBlob({ sandbox: { merchantId: 'MID-1-1' } });
    const { result, stored } = await runConnectionTest(row({ credentials: partial }));
    expect(result.code).toBe('incomplete');
    expect(stored.fingerprint).toBeNull();
  });
});
