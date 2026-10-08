/**
 * The shipping half of the provider framework (shipping batch, rulings PROVIDERS-2/3/9):
 * catalog scope, the per-mode encrypted carrier blob (and the legacy flat shape), write-only
 * views, the connection-test fingerprint and the enable gate.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  SHIPPING_PROVIDER_CODES,
  PROVIDER_CATALOG,
  getProviderEntry,
  providersOfKind,
} from '@force/shared';
import { encryption } from '@api/services/encryption.service';
import {
  activeCredentials,
  activeFieldSet,
  decryptCarrierBlob,
  encryptCarrierBlob,
} from '@api/services/carriers/carrier-credentials';
import {
  applyCarrierCredentialUpdate,
  assertCarrierEnableAllowed,
  assertMayConfigureCarrier,
  carrierEntry,
  carrierTestIsCurrent,
  publicCarrierConfig,
  rotateBlobWebhookSecret,
  runCarrierConnectionTest,
} from '@api/services/carriers/carrier-connection.service';
import { CARRIER_CODES } from '@api/services/carriers/types';
import { CARRIER_REGISTRY } from '@api/services/carriers/registry';
import { carrierFingerprint } from '@api/services/carriers/carrier-credentials';

const bosta = getProviderEntry('bosta')!;
const aramex = getProviderEntry('aramex')!;

afterEach(() => {
  delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
  vi.unstubAllEnvs();
});

describe('shipping catalog scope (PROVIDERS-3)', () => {
  it('ships exactly Bosta, ShipBlu, Mylerz, Aramex and manual delivery', () => {
    expect([...SHIPPING_PROVIDER_CODES].sort()).toEqual(
      ['aramex', 'bosta', 'manual', 'mylerz', 'shipblu'].sort()
    );
    expect([...CARRIER_CODES].sort()).toEqual([...SHIPPING_PROVIDER_CODES].sort());
  });

  it('iCarry is gone from the catalog and the carrier registry', () => {
    expect(getProviderEntry('icarry')).toBeUndefined();
    expect(Object.keys(CARRIER_REGISTRY)).not.toContain('icarry');
    expect(CARRIER_CODES as readonly string[]).not.toContain('icarry');
  });

  it('every API carrier has a real adapter with a connection test; no carrier field is a URL', () => {
    for (const e of providersOfKind('shipping').filter(p => !p.manual)) {
      const adapter = CARRIER_REGISTRY[e.code as keyof typeof CARRIER_REGISTRY];
      expect(adapter?.testConnection, e.code).toBeTypeOf('function');
      expect(adapter.capabilities.webhooks, e.code).toBe(e.capabilities.webhooks);
      // SSRF: a merchant never supplies a host (every adapter resolves it from code / ENV).
      for (const f of e.fields)
        expect(f.key, `${e.code}.${f.key}`).not.toMatch(/url|uri|host|endpoint/i);
    }
  });

  it('nothing is verified yet: every API carrier is "coming soon" (PROVIDERS-2)', () => {
    for (const e of providersOfKind('shipping')) {
      if (e.manual) expect(e.verified).toBe(true);
      else expect(e.verified, e.code).toBe(false);
    }
    expect(PROVIDER_CATALOG.filter(p => p.kind === 'shipping' && !p.manual && p.verified)).toEqual(
      []
    );
  });

  it('every carrier field is bilingual with a "where to find" line', () => {
    for (const e of providersOfKind('shipping').filter(p => !p.manual)) {
      expect(e.fields.length, e.code).toBeGreaterThan(0);
      for (const f of e.fields) {
        for (const t of [f.label, f.help, f.whereToFind]) {
          expect(t.en.length, `${e.code}.${f.key}`).toBeGreaterThan(0);
          expect(t.ar.length, `${e.code}.${f.key}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('carrier credential blob', () => {
  const blob = {
    sandbox: { apiKey: 'sandbox-key-aaaaaaaaaaaaaaaa' },
    live: { apiKey: 'live-key-bbbbbbbbbbbbbbbbbbbb' },
    webhookSecret: 'abc123',
  };

  it('keeps sandbox and live apart; the active mode picks the set; the webhook secret rides along', () => {
    const cipher = encryptCarrierBlob(blob);
    expect(cipher).not.toContain('sandbox-key');
    expect(activeCredentials({ carrier: 'bosta', testMode: true, credentials: cipher })).toEqual({
      apiKey: 'sandbox-key-aaaaaaaaaaaaaaaa',
      webhookSecret: 'abc123',
    });
    expect(activeCredentials({ carrier: 'bosta', testMode: false, credentials: cipher })).toEqual({
      apiKey: 'live-key-bbbbbbbbbbbbbbbbbbbb',
      webhookSecret: 'abc123',
    });
    // the webhook secret is never part of what a Test connection proves
    expect(activeFieldSet({ carrier: 'bosta', testMode: false, credentials: cipher })).toEqual({
      apiKey: 'live-key-bbbbbbbbbbbbbbbbbbbb',
    });
  });

  it('reads a legacy flat map as the live set (sandbox when settings said so) and keeps its webhook secret', () => {
    const flat = encryption.encrypt(JSON.stringify({ apiKey: 'old', webhookSecret: 'w' }));
    expect(decryptCarrierBlob(flat, {})).toEqual({ live: { apiKey: 'old' }, webhookSecret: 'w' });
    expect(decryptCarrierBlob(flat, { sandbox: true })).toEqual({
      sandbox: { apiKey: 'old' },
      webhookSecret: 'w',
    });
  });

  it('refuses ciphertext it cannot read instead of treating it as "no credentials"', () => {
    expect(() => decryptCarrierBlob('not-a-real-ciphertext')).toThrow();
    expect(() => decryptCarrierBlob({ apiKey: 'x' } as unknown as string)).toThrow(
      /not an encrypted/
    );
  });
});

describe('applyCarrierCredentialUpdate (write-only credentials)', () => {
  it('validates against the catalog: unknown key, missing format, control characters', () => {
    expect(() =>
      applyCarrierCredentialUpdate(bosta, null, {
        mode: 'sandbox',
        fields: { baseUrl: 'http://169.254.169.254' },
      })
    ).toThrow(/not a bosta credential/);
    expect(() =>
      applyCarrierCredentialUpdate(bosta, null, {
        mode: 'sandbox',
        fields: { businessLocationId: 'has space!' },
      })
    ).toThrow(/wrong format/);
    expect(() =>
      applyCarrierCredentialUpdate(aramex, null, { mode: 'live', fields: { accountEntity: 'C1R' } })
    ).toThrow(/wrong format/);
    expect(() =>
      applyCarrierCredentialUpdate(bosta, null, { mode: 'live', fields: { apiKey: 'a\u0000b' } })
    ).toThrow(/control characters/);
  });

  it('creates the webhook secret once for a webhook carrier and never changes it on later saves', () => {
    const a = applyCarrierCredentialUpdate(bosta, null, {
      mode: 'sandbox',
      fields: { apiKey: 'k1-aaaaaaaaaaaaaaaaaa' },
    });
    const s1 = decryptCarrierBlob(a.cipher).webhookSecret;
    expect(s1).toMatch(/^[0-9a-f]{48}$/);
    const b = applyCarrierCredentialUpdate(
      bosta,
      { carrier: 'bosta', testMode: true, credentials: a.cipher },
      { mode: 'live', fields: { apiKey: 'k2-bbbbbbbbbbbbbbbbbb' } }
    );
    expect(decryptCarrierBlob(b.cipher).webhookSecret).toBe(s1);
    expect(decryptCarrierBlob(b.cipher).sandbox).toEqual({ apiKey: 'k1-aaaaaaaaaaaaaaaaaa' });
    // a carrier without callbacks never gets one
    const c = applyCarrierCredentialUpdate(aramex, null, {
      mode: 'live',
      fields: { username: 'u' },
    });
    expect(decryptCarrierBlob(c.cipher).webhookSecret).toBeUndefined();
  });

  it('a masked echo or empty value keeps the saved secret; null clears; the hints never hold a secret', () => {
    const key = 'super-secret-key-1234567890';
    const a = applyCarrierCredentialUpdate(bosta, null, { mode: 'live', fields: { apiKey: key } });
    const row = { carrier: 'bosta', testMode: false, credentials: a.cipher };
    const b = applyCarrierCredentialUpdate(bosta, row, {
      mode: 'live',
      fields: { apiKey: '****7890', businessLocationId: 'LOC123' },
    });
    expect(b.changed).toEqual(['businessLocationId']);
    expect(decryptCarrierBlob(b.cipher).live?.apiKey).toBe(key);
    expect(JSON.stringify(b.hints)).not.toContain(key);
    expect(b.hints.live?.apiKey).toEqual({ set: true, last4: '7890' });
    expect(b.hints.live?.businessLocationId).toEqual({ set: true, value: 'LOC123' });
    const c = applyCarrierCredentialUpdate(
      bosta,
      { ...row, credentials: b.cipher },
      {
        mode: 'live',
        fields: { businessLocationId: null, apiKey: '' },
      }
    );
    expect(decryptCarrierBlob(c.cipher).live?.businessLocationId).toBeUndefined();
    expect(decryptCarrierBlob(c.cipher).live?.apiKey).toBe(key);
  });

  it('flags a change to the ACTIVE mode only', () => {
    const a = applyCarrierCredentialUpdate(bosta, null, {
      mode: 'sandbox',
      fields: { apiKey: 'k-aaaaaaaaaaaaaaaaaaaa' },
    });
    const row = { carrier: 'bosta', testMode: true, credentials: a.cipher };
    expect(
      applyCarrierCredentialUpdate(bosta, row, {
        mode: 'live',
        fields: { apiKey: 'l-bbbbbbbbbbbbbbbbbbbb' },
      }).activeModeChanged
    ).toBe(false);
    expect(
      applyCarrierCredentialUpdate(bosta, row, {
        mode: 'sandbox',
        fields: { apiKey: 'm-cccccccccccccccccccc' },
      }).activeModeChanged
    ).toBe(true);
  });

  it('rotating the webhook secret replaces only the secret', () => {
    const a = applyCarrierCredentialUpdate(bosta, null, {
      mode: 'live',
      fields: { apiKey: 'k-aaaaaaaaaaaaaaaaaaaa' },
    });
    const before = decryptCarrierBlob(a.cipher);
    const after = decryptCarrierBlob(rotateBlobWebhookSecret(a.cipher));
    expect(after.webhookSecret).not.toBe(before.webhookSecret);
    expect(after.live).toEqual(before.live);
  });
});

describe('the enable gate (PROVIDERS-2 + current Test connection)', () => {
  const key = 'gate-key-aaaaaaaaaaaaaaaaaaaa';
  const make = (testMode: boolean) =>
    applyCarrierCredentialUpdate(bosta, null, {
      mode: testMode ? 'sandbox' : 'live',
      fields: { apiKey: key },
    });
  const row = (cipher: string, testMode: boolean, over: Record<string, unknown> = {}) => ({
    carrier: 'bosta',
    enabled: true,
    testMode,
    credentials: cipher,
    settings: {},
    connectionTest: null as unknown,
    ...over,
  });
  const okTest = (mode: 'sandbox' | 'live', fields: Record<string, string>) => ({
    ok: true,
    code: 'ok',
    mode,
    at: new Date().toISOString(),
    fingerprint: carrierFingerprint('bosta', mode, fields),
  });

  it('an unverified carrier cannot be enabled, whatever the test says', () => {
    const u = make(true);
    expect(() =>
      assertCarrierEnableAllowed(
        row(u.cipher, true, { connectionTest: okTest('sandbox', { apiKey: key }) })
      )
    ).toThrow(/not activated/);
  });

  it('an unverified carrier activated for the store passes the verified check but still needs the test', () => {
    const u = make(true);
    expect(() =>
      assertCarrierEnableAllowed(
        row(u.cipher, true, { connectionTest: okTest('sandbox', { apiKey: key }) }),
        { storeActivated: true }
      )
    ).not.toThrow();
    expect(() => assertCarrierEnableAllowed(row(u.cipher, true), { storeActivated: true })).toThrow(
      /Test connection/
    );
  });

  it('with the stub seam: needs a successful test for EXACTLY the current credentials', () => {
    process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = '1';
    const u = make(true);
    expect(() => assertCarrierEnableAllowed(row(u.cipher, true))).toThrow(/Test connection/);
    const tested = okTest('sandbox', { apiKey: key });
    expect(() =>
      assertCarrierEnableAllowed(row(u.cipher, true, { connectionTest: tested }))
    ).not.toThrow();
    // edited key -> the old test is stale
    const edited = applyCarrierCredentialUpdate(
      bosta,
      { carrier: 'bosta', testMode: true, credentials: u.cipher },
      { mode: 'sandbox', fields: { apiKey: 'edited-key-aaaaaaaaaaaaaaaaa' } }
    );
    expect(carrierTestIsCurrent(row(edited.cipher, true, { connectionTest: tested }))).toBe(false);
    // mode switch -> the sandbox test does not cover live
    const both = applyCarrierCredentialUpdate(
      bosta,
      { carrier: 'bosta', testMode: true, credentials: u.cipher },
      { mode: 'live', fields: { apiKey: key } }
    );
    expect(carrierTestIsCurrent(row(both.cipher, false, { connectionTest: tested }))).toBe(false);
    // a failed test never opens the gate
    expect(
      carrierTestIsCurrent(row(u.cipher, true, { connectionTest: { ...tested, ok: false } }))
    ).toBe(false);
  });

  it('anyone may configure and test an unverified carrier (PROVIDERS-ACTIVATION); unknown ones are refused', () => {
    expect(() => assertMayConfigureCarrier('bosta', 'store_admin')).not.toThrow();
    expect(() => assertMayConfigureCarrier('bosta', 'super_admin')).not.toThrow();
    expect(() => assertMayConfigureCarrier('icarry', 'store_admin')).toThrow(/Unknown carrier/);
    expect(() => assertMayConfigureCarrier('manual', 'store_admin')).not.toThrow();
  });

  it('manual delivery has nothing to connect', () => {
    expect(() => carrierEntry('manual')).toThrow(/no credentials/);
    expect(() => carrierEntry('cod')).toThrow(/Unknown carrier/);
    expect(() => carrierEntry('icarry')).toThrow(/Unknown carrier/);
  });
});

describe('Test connection + the public view', () => {
  it('reports incomplete credentials without calling the carrier', async () => {
    const u = applyCarrierCredentialUpdate(aramex, null, {
      mode: 'sandbox',
      fields: { username: 'u' },
    });
    const r = await runCarrierConnectionTest(
      { carrier: 'aramex', enabled: false, testMode: true, credentials: u.cipher, settings: {} },
      {}
    );
    expect(r.result.code).toBe('incomplete');
    expect(r.stored.fingerprint).toBeNull();
  });

  it("runs the adapter in the row's mode and stores a fingerprint only on success", async () => {
    const u = applyCarrierCredentialUpdate(bosta, null, {
      mode: 'sandbox',
      fields: { apiKey: 'k-aaaaaaaaaaaaaaaaaaaa' },
    });
    const spy = vi
      .spyOn(CARRIER_REGISTRY.bosta, 'testConnection')
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: false,
        code: 'bad_credentials',
        error: 'Bosta refused the API key',
      });
    const base = {
      carrier: 'bosta',
      enabled: false,
      testMode: true,
      credentials: u.cipher,
      settings: {},
    };
    const ok = await runCarrierConnectionTest(base, {});
    expect(spy.mock.calls[0][1]?.settings?.sandbox).toBe(true);
    expect(spy.mock.calls[0][0]).toEqual({ apiKey: 'k-aaaaaaaaaaaaaaaaaaaa' }); // no webhook secret in the proof
    expect(ok.result).toMatchObject({ ok: true, code: 'ok' });
    expect(ok.stored.fingerprint).toMatch(/\S+/);
    const bad = await runCarrierConnectionTest(base, {});
    expect(bad.result).toMatchObject({ ok: false, code: 'bad_credentials' });
    expect(bad.stored.fingerprint).toBeNull();
    spy.mockRestore();
  });

  it('a thrown adapter bug never leaks into the result', async () => {
    const u = applyCarrierCredentialUpdate(bosta, null, {
      mode: 'live',
      fields: { apiKey: 'secret-aaaaaaaaaaaaaaaaaaaa' },
    });
    const spy = vi
      .spyOn(CARRIER_REGISTRY.bosta, 'testConnection')
      .mockRejectedValueOnce(new Error('boom secret-aaaaaaaaaaaaaaaaaaaa'));
    const r = await runCarrierConnectionTest(
      { carrier: 'bosta', enabled: false, testMode: false, credentials: u.cipher, settings: {} },
      {}
    );
    expect(JSON.stringify(r)).not.toContain('secret-aaaa');
    spy.mockRestore();
  });

  it('the browser view carries no ciphertext, no fingerprint and no webhook secret', () => {
    const u = applyCarrierCredentialUpdate(bosta, null, {
      mode: 'live',
      fields: { apiKey: 'visible-key-aaaaaaaaaaaaaaaa' },
    });
    const view = publicCarrierConfig({
      id: 'x',
      carrier: 'bosta',
      enabled: true,
      testMode: false,
      credentials: u.cipher,
      credentialHints: u.hints,
      connectionTest: { ok: true, code: 'ok', mode: 'live', at: 'now', fingerprint: 'FP' },
    });
    const text = JSON.stringify(view);
    expect(view.credentials).toBeUndefined();
    expect(text).not.toContain('visible-key');
    expect(text).not.toContain('"fingerprint');
    expect(text).not.toContain(decryptCarrierBlob(u.cipher).webhookSecret!);
    expect(view.mode).toBe('live');
  });
});
