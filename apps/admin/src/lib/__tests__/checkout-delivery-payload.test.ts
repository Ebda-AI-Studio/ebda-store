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
  kwdInputToFils,
  type CheckoutDeliveryForm,
} from '../checkout-delivery-payload';

const CONFIG = {
  note: { enabled: false, text: '', textAr: '' },
  windows: { enabled: false, items: [] },
} as CheckoutDeliveryForm['config'];

/** The store's `settings` JSON as loaded from the API. */
const STORED = {
  currency: 'KWD',
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
      minimumOrderKwd: '5.000',
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
      minimumOrderKwd: '',
      orderInvoiceEmail: '   ',
    });
    expect(body.orderInvoiceEmail).toBeNull();
  });

  it("the server's shallow merge no longer resurrects the removed address", () => {
    const body = serialize({
      existingSettings: STORED,
      config: CONFIG,
      minimumOrderKwd: '5.000',
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
      minimumOrderKwd: '5.000',
      orderInvoiceEmail: '  owner@store.com  ',
    });
    expect(body.orderInvoiceEmail).toBe('owner@store.com');
    expect(serverMerge(STORED, body).orderInvoiceEmail).toBe('owner@store.com');
  });

  it('passes every other stored settings key through untouched', () => {
    const body = serialize({
      existingSettings: { ...STORED, floatingWidget: { enabled: true }, navMenu: [] },
      config: CONFIG,
      minimumOrderKwd: '2.500',
      orderInvoiceEmail: 'owner@store.com',
    });
    expect(body.currency).toBe('KWD');
    expect(body.floatingWidget).toEqual({ enabled: true });
    expect(body.navMenu).toEqual([]);
    expect(body.checkoutDelivery).toEqual(CONFIG);
    expect(body.minimumOrderFils).toBe(2500);
  });
});

describe('kwdInputToFils', () => {
  it('rounds a KWD string to integer fils', () => {
    expect(kwdInputToFils('5.000')).toBe(5000);
    expect(kwdInputToFils('2.5')).toBe(2500);
    expect(kwdInputToFils('0.0015')).toBe(2);
  });

  it('resolves empty / invalid / non-positive input to 0 (= no minimum)', () => {
    expect(kwdInputToFils('')).toBe(0);
    expect(kwdInputToFils('  ')).toBe(0);
    expect(kwdInputToFils('abc')).toBe(0);
    expect(kwdInputToFils('-3')).toBe(0);
    expect(kwdInputToFils('0')).toBe(0);
  });
});
