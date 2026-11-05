/**
 * SHARIA-BNPL-1: installment providers (valU, Kiosk Aman/Masary, Kashier bnpl) are OFF for a new store, and
 * turning one on shows the disclosure (the provider's own terms and fees apply to the customer).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BNPL_DISCLOSURE,
  BNPL_METHOD_CODES,
  kashierSettingsSchema,
  paymobSettingsBaseSchema,
  PROVIDER_CATALOG,
} from '@ebda/shared';
import { enabledMethods } from '../../apps/api/src/services/payment-providers/provider-methods';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

describe('BNPL is off by default', () => {
  it('Kashier: a fresh settings blob offers card + wallet only', () => {
    const fresh = kashierSettingsSchema.parse({});
    expect(fresh.methods).toEqual(['card', 'wallet']);
    expect(enabledMethods('kashier', {})).toEqual(['card', 'wallet']);
  });

  it('Paymob: no integration id by default, so valU and Kiosk are not offered', () => {
    expect(paymobSettingsBaseSchema.parse({}).integrationIds).toEqual({});
    expect(enabledMethods('paymob', {})).toEqual([]);
    const cardOnly = { publicKey: 'pk_test_12345678', integrationIds: { card: 1, wallet: 2 } };
    const offered = enabledMethods('paymob', cardOnly);
    for (const code of BNPL_METHOD_CODES) expect(offered).not.toContain(code);
  });

  it('no payment provider in the catalog enables an installment method by default', () => {
    // The catalog fields are empty inputs; nothing pre-fills a value.
    for (const p of PROVIDER_CATALOG.filter(x => x.kind === 'payments'))
      for (const f of p.fields) expect('default' in f && f.default !== undefined).toBe(false);
  });

  it('no migration, seed or schema default switches an installment method on', () => {
    const shared = read('packages/shared/src/payments.ts');
    expect(shared).toMatch(/\.default\(\['card', 'wallet'\]\)/);
    expect(shared).not.toMatch(/default\(\[[^\]]*bnpl/);
  });
});

describe('enabling an installment provider shows the disclosure', () => {
  it('the admin shows it under the valU / Kiosk fields and the Kashier bnpl option', () => {
    const card = read(
      'apps/admin/src/app/stores/[id]/payment-settings/_components/GatewayConnectCard.tsx'
    );
    expect(card).toMatch(/integrationId\.valu/);
    expect(card).toMatch(/integrationId\.kiosk/);
    expect(card).toMatch(/methods\.includes\('bnpl'\)/);
    expect((card.match(/bnplDisclosure/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('the admin messages carry the shared disclosure text in en and ar', () => {
    const en = JSON.parse(read('apps/admin/src/i18n/messages/en.json'));
    const ar = JSON.parse(read('apps/admin/src/i18n/messages/ar.json'));
    expect(en.paymentSettings.connect.bnplDisclosure).toBe(BNPL_DISCLOSURE.en);
    expect(ar.paymentSettings.connect.bnplDisclosure).toBe(BNPL_DISCLOSURE.ar);
  });
});
