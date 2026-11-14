/**
 * Server-owned keys inside the merchant-writable settings JSON: a client can neither add, change
 * nor erase them, whatever the writer (create, update, super-admin provisioning).
 */
import { describe, it, expect } from 'vitest';
import {
  ECHOED_SERVER_OWNED_KEYS,
  SERVER_OWNED_SETTINGS_KEYS,
  mergeClientSettings,
  reservedSettingsKeys,
  stripServerOwnedSettings,
} from '@ebda/shared';

describe('server-owned settings keys: the MCP switch and the gold flag (BE:S-8, Ruling FP-1)', () => {
  it('reserves mcpWriteEnabled and goldAllowDeferredPayment', () => {
    expect(SERVER_OWNED_SETTINGS_KEYS).toEqual(
      expect.arrayContaining(['mcpWriteEnabled', 'goldAllowDeferredPayment'])
    );
  });
  it('a generic merge can neither flip, plant nor erase either flag', () => {
    const existing = { mcpWriteEnabled: false, goldAllowDeferredPayment: false, a: 1 };
    expect(
      mergeClientSettings(existing, { mcpWriteEnabled: true, goldAllowDeferredPayment: true, a: 2 })
    ).toEqual({ mcpWriteEnabled: false, goldAllowDeferredPayment: false, a: 2 });
    expect(mergeClientSettings({ a: 1 }, { mcpWriteEnabled: false })).toEqual({ a: 1 });
    expect(mergeClientSettings(existing, { mcpWriteEnabled: null })).toEqual(existing);
  });
  it('the flags a stale whole copy echoes back are listed as silently dropped', () => {
    expect([...ECHOED_SERVER_OWNED_KEYS].sort()).toEqual([
      'autoRecommendationsEnabled',
      'goldAllowDeferredPayment',
      'mcpWriteEnabled',
    ]);
    for (const k of ECHOED_SERVER_OWNED_KEYS) expect(SERVER_OWNED_SETTINGS_KEYS).toContain(k);
    expect(ECHOED_SERVER_OWNED_KEYS).not.toContain('ebdaWhatsApp'); // a planted platform link still answers 400
  });
});

describe('server-owned settings keys', () => {
  it('reserves the WhatsApp link key and strips it from client settings', () => {
    expect(SERVER_OWNED_SETTINGS_KEYS).toEqual(expect.arrayContaining(['ebdaWhatsApp']));
    expect(stripServerOwnedSettings({ ebdaWhatsApp: { linked: true }, a: 1 })).toEqual({ a: 1 });
  });

  it('detects a reserved key (and only that)', () => {
    expect(reservedSettingsKeys({ ebdaWhatsApp: { linked: true }, theme: 'x' })).toEqual([
      'ebdaWhatsApp',
    ]);
    expect(reservedSettingsKeys({ theme: 'x' })).toEqual([]);
    expect(reservedSettingsKeys(undefined)).toEqual([]);
    expect(reservedSettingsKeys([])).toEqual([]);
  });

  it('strips a planted key from client input', () => {
    expect(stripServerOwnedSettings({ a: 1, ebdaWhatsApp: { linked: true } })).toEqual({ a: 1 });
  });

  describe('mergeClientSettings (the update path)', () => {
    it('a merchant PATCH with ebdaWhatsApp.linked=true has no effect', () => {
      expect(
        mergeClientSettings({ currency: 'EGP' }, { ebdaWhatsApp: { linked: true }, theme: 't' })
      ).toEqual({
        currency: 'EGP',
        theme: 't',
      });
    });
    it('the server value survives a client trying to change it', () => {
      const existing = { ebdaWhatsApp: { linked: false, by: 'server' }, a: 1 };
      expect(mergeClientSettings(existing, { ebdaWhatsApp: { linked: true }, a: 2 })).toEqual({
        ebdaWhatsApp: { linked: false, by: 'server' },
        a: 2,
      });
    });
    it('and survives a client trying to erase it', () => {
      const existing = { ebdaWhatsApp: { linked: true }, a: 1 };
      expect(mergeClientSettings(existing, { ebdaWhatsApp: null })).toEqual(existing);
    });
    it('ordinary keys merge as before (shallow, client wins)', () => {
      expect(mergeClientSettings({ a: 1, b: { x: 1 } }, { b: { y: 2 } })).toEqual({
        a: 1,
        b: { y: 2 },
      });
    });
    it('no existing settings', () => {
      expect(mergeClientSettings(null, { a: 1, ebdaWhatsApp: 1 })).toEqual({ a: 1 });
    });
  });
});
