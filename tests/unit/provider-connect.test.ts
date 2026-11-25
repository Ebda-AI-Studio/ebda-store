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
} from '@ebda/shared';
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
  'docs.geidea.net',
  'atfawry.fawrystaging.com',
  // shipping carriers (the shipping batch)
  'docs.bosta.co',
  'business.bosta.co',
  'docs.shipblu.com',
  'shipblu.com',
  'integration.mylerz.net',
  'mylerz.net',
  'www.aramex.com',
];

const paymob = getProviderEntry('paymob')!;
const kashier = getProviderEntry('kashier')!;

describe('provider catalog', () => {
  it('lists exactly the supported payment providers (Ahmad, 2026-10-07)', () => {
    expect([...PAYMENT_PROVIDER_CODES].sort()).toEqual(
      ['cod', 'fawry', 'geidea', 'instapay', 'kashier', 'paymob'].sort()
    );
    const codes = PROVIDER_CATALOG.map(p => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every gateway has an adapter with a connection test and webhook wiring', () => {
    const gateways = PROVIDER_CATALOG.filter(p => p.kind === 'payments' && !p.manual);
    // PROVIDERS-3: a gateway with no documented harmless call has no testConnection ("unverified").
    const NO_SAFE_CHECK = ['geidea'];
    for (const g of gateways) {
      if (NO_SAFE_CHECK.includes(g.code)) {
        expect(getProviderV2(g.code), g.code).toBeDefined();
        expect(getProviderV2(g.code)?.testConnection, g.code).toBeUndefined();
        continue;
      }
      expect(getProviderV2(g.code)?.testConnection, g.code).toBeTypeOf('function');
    }
    expect([...GATEWAY_WEBHOOK_PROVIDERS].sort()).toEqual(gateways.map(g => g.code).sort());
  });

  it('GW-VERIFIED-1: an API provider is verified only with an evidence reference (date AND run id/link)', () => {
    for (const p of PROVIDER_CATALOG.filter(e => !e.manual)) {
      if (!p.verified) continue;
      const ev = p.verification.evidence;
      expect(ev, `${p.code}: verified with no evidence`).not.toBeNull();
      expect(ev!.runAt, p.code).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        ev!.runRef.trim().length,
        `${p.code}: evidence needs a run id or link`
      ).toBeGreaterThan(3);
    }
    // No API provider has a recorded full run yet (Kashier's 2026-10-08 claim had no record).
    expect(PROVIDER_CATALOG.filter(p => !p.manual && p.verified).map(p => p.code)).toEqual([]);
    // The verification shape carries no bare date field any more.
    for (const p of PROVIDER_CATALOG)
      expect(Object.keys(p.verification).sort(), p.code).toEqual(['evidence', 'note']);
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

describe('provider gate (PROVIDERS-3)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = saved.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    process.env.NODE_ENV = saved.NODE_ENV;
  });

  it('every catalog provider is usable (PROVIDERS-3); an unknown code is not', () => {
    expect(isProviderUsable('paymob')).toBe(true);
    expect(isProviderUsable('kashier')).toBe(true);
    expect(isProviderUsable('fawry')).toBe(true);
    expect(isProviderUsable('cod')).toBe(true);
    expect(isProviderUsable('instapay')).toBe(true);
    expect(isProviderUsable('geidea')).toBe(true);
    expect(isProviderUsable('nope')).toBe(false);
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

  it('an unverified provider is enabled by a current test alone, never without it (PROVIDERS-3)', () => {
    delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    const paymobTest = {
      ...okTest,
      fingerprint: connectionFingerprint('paymob', 'sandbox', fields),
    };
    expect(() =>
      assertEnableAllowed(row({ provider: 'paymob', connectionTest: paymobTest }))
    ).not.toThrow();
    expect(() => assertEnableAllowed(row({ provider: 'paymob', connectionTest: null }))).toThrow(
      /Test connection/
    );
  });

  it('allows a verified provider with a current test (PROVIDERS-2)', () => {
    delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    expect(() => assertEnableAllowed(row())).not.toThrow();
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

  it('checks the SAVED mode when asked (sandbox first), not the active one (PROVIDERS-3)', async () => {
    // sandbox is active and complete; nothing is saved for live: a live check says incomplete
    // and sends nothing, while the active-mode check still runs the adapter.
    const { result, stored } = await runConnectionTest(row(), 'live');
    expect(result.code).toBe('incomplete');
    expect(stored.mode).toBe('live');
    expect(stored.fingerprint).toBeNull();
  });
});
