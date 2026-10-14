/**
 * The order-invoice address must be CLEARABLE.
 *
 * Every assertion here runs against the SERIALIZED body, not the object the
 * page builds. That is deliberate: the defect lives inside `JSON.stringify`.
 * The page spreads the store's existing `settings` and then overrides one
 * key, so `{ ...existingSettings, orderInvoiceEmail: undefined }` looks
 * cleared in memory — and serializes to a body with no `orderInvoiceEmail`
 * at all, which the server's shallow merge then fills back in from the
 * STORED value. A test on the pre-serialization object passes on the broken
 * code.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCheckoutDeliverySettings,
  majorInputToMinor,
  parseDeliveryDaysInput,
  type CheckoutDeliveryForm,
} from '../checkout-delivery-payload';

const CONFIG = {
  note: { enabled: false, text: '', textAr: '' },
  windows: { enabled: false, items: [] },
} as CheckoutDeliveryForm['config'];

/** The store's `settings` JSON as loaded from the API. */
const STORED = {
  currency: 'EGP',
  orderInvoiceEmail: 'former.employee@store.com',
  minimumOrderFils: 5000,
};

function serialize(form: CheckoutDeliveryForm) {
  return JSON.parse(JSON.stringify(buildCheckoutDeliverySettings(form))) as Record<string, unknown>;
}

/** What StoreService.update does with the body: shallow-merge over the row. */
function serverMerge(stored: Record<string, unknown>, body: Record<string, unknown>) {
  return { ...stored, ...body };
}

describe('buildCheckoutDeliverySettings — the emptied order-invoice address clears', () => {
  it('serializes an explicit null when the merchant empties the field', () => {
    const body = serialize({
      existingSettings: STORED,
      config: CONFIG,
      minimumOrderMajor: '5.000',
      orderInvoiceEmail: '',
    });

    // The key must SURVIVE serialization — `undefined` would drop it here.
    expect('orderInvoiceEmail' in body).toBe(true);
    expect(body.orderInvoiceEmail).toBeNull();
  });

  it('a whitespace-only address clears too', () => {
    const body = serialize({
      existingSettings: STORED,
      config: CONFIG,
      minimumOrderMajor: '',
      orderInvoiceEmail: '   ',
    });
    expect(body.orderInvoiceEmail).toBeNull();
  });

  it("the server's shallow merge no longer resurrects the removed address", () => {
    const body = serialize({
      existingSettings: STORED,
      config: CONFIG,
      minimumOrderMajor: '5.000',
      orderInvoiceEmail: '',
    });

    // This is the whole bug: with the key dropped, the merge below returned
    // 'former.employee@store.com' and invoices kept being sent to it.
    expect(serverMerge(STORED, body).orderInvoiceEmail).toBeNull();
  });

  it('sends a real address trimmed and unchanged — behaviour is otherwise identical', () => {
    const body = serialize({
      existingSettings: STORED,
      config: CONFIG,
      minimumOrderMajor: '5.000',
      orderInvoiceEmail: '  owner@store.com  ',
    });
    expect(body.orderInvoiceEmail).toBe('owner@store.com');
    expect(serverMerge(STORED, body).orderInvoiceEmail).toBe('owner@store.com');
  });

  it('passes every other stored settings key through untouched', () => {
    const body = serialize({
      existingSettings: { ...STORED, floatingWidget: { enabled: true }, navMenu: [] },
      config: CONFIG,
      minimumOrderMajor: '25.00',
      orderInvoiceEmail: 'owner@store.com',
    });
    expect(body.currency).toBe('EGP');
    expect(body.floatingWidget).toEqual({ enabled: true });
    expect(body.navMenu).toEqual([]);
    expect(body.checkoutDelivery).toEqual(CONFIG);
    expect(body.minimumOrderFils).toBe(2500); // 25.00 EGP in piastres
  });
});

describe('majorInputToMinor', () => {
  it('rounds a EGP string to integer piastres', () => {
    expect(majorInputToMinor('50.00')).toBe(5000);
    expect(majorInputToMinor('25')).toBe(2500);
    expect(majorInputToMinor('0.015')).toBe(2); // 1.5 piastres → half up
  });

  it('resolves empty / invalid / non-positive input to 0 (= no minimum)', () => {
    expect(majorInputToMinor('')).toBe(0);
    expect(majorInputToMinor('  ')).toBe(0);
    expect(majorInputToMinor('abc')).toBe(0);
    expect(majorInputToMinor('-3')).toBe(0);
    expect(majorInputToMinor('0')).toBe(0);
  });
});

describe('store-wide deliveryDays (business days)', () => {
  const base = { config: CONFIG, minimumOrderMajor: '', orderInvoiceEmail: '' };

  it('serializes an explicit null when cleared, so the shallow merge drops the stored value', () => {
    const stored = { ...STORED, deliveryDays: { min: 2, max: 4 } };
    const body = serialize({ ...base, existingSettings: stored, deliveryDays: null });
    expect(body).toHaveProperty('deliveryDays', null);
    expect(serverMerge(stored, body).deliveryDays).toBeNull();
  });

  it('sends the range when set and leaves the stored value alone when undefined', () => {
    expect(
      serialize({ ...base, existingSettings: STORED, deliveryDays: { min: 1, max: 3 } })
        .deliveryDays
    ).toEqual({ min: 1, max: 3 });
    const keep = { ...STORED, deliveryDays: { min: 2, max: 4 } };
    expect(serialize({ ...base, existingSettings: keep }).deliveryDays).toEqual({ min: 2, max: 4 });
  });
});

describe('parseDeliveryDaysInput', () => {
  it('both empty clears, a valid pair parses', () => {
    expect(parseDeliveryDaysInput('', ' ')).toEqual({ ok: true, value: null });
    expect(parseDeliveryDaysInput('2', '4')).toEqual({ ok: true, value: { min: 2, max: 4 } });
    expect(parseDeliveryDaysInput('0', '0')).toEqual({ ok: true, value: { min: 0, max: 0 } });
  });
  it('rejects half-filled, reversed, fractional and out-of-range input', () => {
    for (const [a, b] of [
      ['2', ''],
      ['', '3'],
      ['5', '2'],
      ['1.5', '2'],
      ['-1', '2'],
      ['1', '31'],
      ['x', '2'],
    ]) {
      expect(parseDeliveryDaysInput(a, b)).toEqual({ ok: false });
    }
  });
});
