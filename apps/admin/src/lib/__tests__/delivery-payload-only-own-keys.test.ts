/**
 * BE:F-2: the delivery page sends ONLY its own `settings` keys. It used to read the whole blob and spread it back,
 * so a stale tab silently reverted another page's save (branding, widget, announcement...).
 */
import { describe, expect, it } from 'vitest';
import { buildCheckoutDeliverySettings } from '../checkout-delivery-payload';

const CONFIG = {
  note: { enabled: false, text: '', textAr: '' },
  windows: { enabled: false, items: [] },
} as Parameters<typeof buildCheckoutDeliverySettings>[0]['config'];

describe('buildCheckoutDeliverySettings: only its own keys', () => {
  it("never contains another page's settings key, whatever the form carries", () => {
    const body = JSON.parse(
      JSON.stringify(
        buildCheckoutDeliverySettings({
          // a stale copy of the whole blob must have nowhere to go: the field no longer exists on the form
          ...({
            existingSettings: { floatingWidget: { enabled: true }, contact: { addressUrl: 'x' } },
          } as object),
          config: CONFIG,
          minimumOrderMajor: '10',
          orderInvoiceEmail: 'a@b.co',
        })
      )
    ) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'checkoutDelivery',
      'minimumOrderFils',
      'orderInvoiceEmail',
    ]);
  });

  it('adds the optional keys only when the page sets them', () => {
    const withDays = buildCheckoutDeliverySettings({
      config: CONFIG,
      minimumOrderMajor: '',
      orderInvoiceEmail: '',
      deliveryDays: { min: 1, max: 3 },
      deliveryOffDays: [5],
    });
    expect(Object.keys(withDays).sort()).toEqual([
      'checkoutDelivery',
      'deliveryDays',
      'deliveryOffDays',
      'minimumOrderFils',
      'orderInvoiceEmail',
    ]);
  });
});
