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
  parseDeliveryOffDaysInput,
  offDaysForSave,
  hasSavedOffDays,
  hasInvalidOffDays,
  offDaysFromSettings,
  DELIVERY_WEEK_ORDER,
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
      config: CONFIG,
      minimumOrderMajor: '',
      orderInvoiceEmail: '   ',
    });
    expect(body.orderInvoiceEmail).toBeNull();
  });

  it("the server's shallow merge no longer resurrects the removed address", () => {
    const body = serialize({
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
      config: CONFIG,
      minimumOrderMajor: '5.000',
      orderInvoiceEmail: '  owner@store.com  ',
    });
    expect(body.orderInvoiceEmail).toBe('owner@store.com');
    expect(serverMerge(STORED, body).orderInvoiceEmail).toBe('owner@store.com');
  });

  it('sends only its own keys (no stored key is spread back)', () => {
    const body = serialize({
      config: CONFIG,
      minimumOrderMajor: '25.00',
      orderInvoiceEmail: 'owner@store.com',
    });
    expect(Object.keys(body).sort()).toEqual([
      'checkoutDelivery',
      'minimumOrderFils',
      'orderInvoiceEmail',
    ]);
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
    const body = serialize({ ...base, deliveryDays: null });
    expect(body).toHaveProperty('deliveryDays', null);
    expect(serverMerge(stored, body).deliveryDays).toBeNull();
  });

  it('sends the range when set and leaves the stored value alone when undefined', () => {
    expect(serialize({ ...base, deliveryDays: { min: 1, max: 3 } }).deliveryDays).toEqual({
      min: 1,
      max: 3,
    });
    const keep = { ...STORED, deliveryDays: { min: 2, max: 4 } };
    expect(serialize({ ...base })).not.toHaveProperty('deliveryDays');
    expect(serverMerge(keep, serialize({ ...base })).deliveryDays).toEqual({ min: 2, max: 4 });
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

describe('store deliveryOffDays (days with no delivery)', () => {
  const base = { config: CONFIG, minimumOrderMajor: '', orderInvoiceEmail: '' };

  it('serializes [] (delivers every day) and the chosen days, never dropping the key', () => {
    expect(serialize({ ...base, deliveryOffDays: [] })).toHaveProperty('deliveryOffDays', []);
    expect(serialize({ ...base, deliveryOffDays: [5, 6] }).deliveryOffDays).toEqual([5, 6]);
  });

  it('sends an explicit null to clear and leaves the stored value on undefined', () => {
    const stored = { ...STORED, deliveryOffDays: [6] };
    const cleared = serialize({ ...base, deliveryOffDays: null });
    expect(serverMerge(stored, cleared).deliveryOffDays).toBeNull();
    expect(serialize({ ...base })).not.toHaveProperty('deliveryOffDays');
    expect(serverMerge(stored, serialize({ ...base })).deliveryOffDays).toEqual([6]);
  });

  it('reads unset, null and malformed as the Friday default', () => {
    for (const raw of [undefined, null, 'x', [9], [1, 1]]) {
      expect(offDaysFromSettings(raw)).toEqual([5]);
    }
    expect(offDaysFromSettings([])).toEqual([]);
    expect(offDaysFromSettings([6, 5])).toEqual([6, 5]);
  });

  it('refuses all seven days off, normalises order and drops duplicates', () => {
    expect(parseDeliveryOffDaysInput([0, 1, 2, 3, 4, 5, 6])).toEqual({ ok: false });
    expect(parseDeliveryOffDaysInput([6, 5, 5])).toEqual({ ok: true, value: [5, 6] });
    expect(parseDeliveryOffDaysInput([])).toEqual({ ok: true, value: [] });
  });

  it('lists the chips Saturday-first', () => {
    expect([...DELIVERY_WEEK_ORDER]).toEqual([6, 0, 1, 2, 3, 4, 5]);
  });
});

describe('offDaysForSave (the default is not pinned)', () => {
  it('omits the untouched default for a store with no saved value', () => {
    expect(offDaysForSave([5], false)).toEqual({ ok: true, value: undefined });
  });
  it('keeps explicit choices: a saved [5], any other selection, and []', () => {
    expect(offDaysForSave([5], true)).toEqual({ ok: true, value: [5] });
    expect(offDaysForSave([6, 5], false)).toEqual({ ok: true, value: [5, 6] });
    expect(offDaysForSave([], false)).toEqual({ ok: true, value: [] });
  });
  it('resets an invalid stored value to the default (null) so it cannot block every save', () => {
    expect(hasInvalidOffDays('friday')).toBe(true);
    expect(hasInvalidOffDays([9])).toBe(true);
    expect(hasInvalidOffDays(undefined)).toBe(false);
    expect(hasInvalidOffDays(null)).toBe(false);
    expect(hasInvalidOffDays([5])).toBe(false);
    expect(offDaysForSave([5], false, true)).toEqual({ ok: true, value: null });
    // an explicit non-default choice still overwrites it
    expect(offDaysForSave([6], false, true)).toEqual({ ok: true, value: [6] });
    expect(
      buildCheckoutDeliverySettings({
        config: {} as never,
        minimumOrderMajor: '',
        orderInvoiceEmail: '',
        deliveryOffDays: null,
      }).deliveryOffDays
    ).toBeNull();
  });
  it('still refuses all seven', () => {
    expect(offDaysForSave([0, 1, 2, 3, 4, 5, 6], true)).toEqual({ ok: false });
  });
  it('hasSavedOffDays is true only for a valid stored array', () => {
    expect(hasSavedOffDays(undefined)).toBe(false);
    expect(hasSavedOffDays(null)).toBe(false);
    expect(hasSavedOffDays('friday')).toBe(false);
    expect(hasSavedOffDays([5])).toBe(true);
    expect(hasSavedOffDays([])).toBe(true);
  });
});
