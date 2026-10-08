import { describe, expect, it } from 'vitest';
import { formatAddressLines as adminLines } from '../../apps/admin/src/app/stores/[id]/orders/[orderId]/_components/format';
import { formatAddressLines as ordersLines } from '../../apps/orders/src/lib/format';
import { shortAddress } from '../../packages/shared/src/whatsapp/wa-me-messages';
import { formatShippingAddress } from '../../apps/api/src/services/customer-aggregate.service';

// What the Egyptian storefront checkout writes: city is EMPTY, landmark rides in address2.
const checkoutAddr = {
  firstName: 'Mona',
  lastName: 'Ali',
  address1: 'شارع النصر, Building 5, Floor 3',
  address2: 'جنب الصيدلية',
  area: 'Nasr City',
  areaAr: 'مدينة نصر',
  governorate: 'Cairo',
  governorateAr: 'القاهرة',
  street: 'شارع النصر',
  building: '5',
  floor: '3',
  city: '',
  country: 'Egypt',
  phone: '01012345678',
};

describe.each([
  ['admin', adminLines],
  ['orders PWA', ordersLines],
])('%s delivery card', (_n, fn) => {
  it('shows governorate + area (Arabic when ar) and no raw key: value dump', () => {
    const ar = fn(checkoutAddr as never, undefined, 'ar').join('\n');
    expect(ar).toContain('مدينة نصر');
    expect(ar).toContain('القاهرة');
    expect(ar).not.toMatch(/governorate/i);
    const en = fn(checkoutAddr as never, undefined, 'en').join('\n');
    expect(en).toContain('Nasr City');
    expect(en).toContain('Cairo');
    expect(en).not.toMatch(/governorateAr|areaAr/);
  });

  it('always shows the landmark on its own labelled line', () => {
    const ar = fn(checkoutAddr as never, undefined, 'ar');
    expect(ar).toContain('علامة مميزة: جنب الصيدلية');
    expect(fn(checkoutAddr as never, undefined, 'en')).toContain('Landmark: جنب الصيدلية');
  });

  it('prints each location once when city == governorate', () => {
    const lines = fn(
      { country: 'Egypt', city: 'Cairo', governorate: 'Cairo', address1: 'x' } as never,
      undefined,
      'en'
    );
    expect(lines[0]).toBe('Egypt - Cairo');
  });
});

describe('other address renderers', () => {
  it('wa.me short address uses area + governorate, in the message language', () => {
    expect(shortAddress(checkoutAddr, 'ar')).toBe(
      'شارع النصر, Building 5, Floor 3، مدينة نصر، القاهرة'
    );
    expect(shortAddress(checkoutAddr, 'en')).toBe(
      'شارع النصر, Building 5, Floor 3, Nasr City, Cairo'
    );
    expect(shortAddress({ address1: 'A', city: 'Giza', state: 'Giza' })).toBe('A, Giza');
  });

  it('customer aggregate address includes the governorate without repeats', () => {
    expect(
      formatShippingAddress({
        address1: 'A',
        area: 'Maadi',
        governorate: 'Cairo',
        country: 'Egypt',
      })
    ).toBe('A, Maadi, Cairo, Egypt');
  });
});

import { orderConfirmationTemplate } from '@api/services/email-templates/order-confirmation';

describe('order confirmation email delivery address', () => {
  const base = {
    orderNumber: 'N-1',
    customerName: 'A',
    customerEmail: 'a@x.test',
    items: [{ name: 'Dates', quantity: 1, price: 5000 }],
    subtotal: 5000,
    tax: 0,
    shipping: 500,
    total: 5500,
  };
  const addr = {
    ...checkoutAddr,
    state: '',
    postalCode: '',
    address1: 'Street 9',
    address2: 'near <b>mosque</b>',
  };

  it.each(['en', 'ar'] as const)(
    '%s: governorate + area + landmark, no stray ", " line, landmark escaped',
    loc => {
      const html = orderConfirmationTemplate[loc]({ ...base, shippingAddress: addr } as never, 'S');
      const box = html.slice(html.indexOf('address-box'));
      expect(box).toContain(loc === 'ar' ? 'القاهرة' : 'Cairo');
      expect(box).toContain(loc === 'ar' ? 'مدينة نصر' : 'Nasr City');
      expect(box).toContain('near &lt;b&gt;mosque&lt;/b&gt;');
      expect(box).not.toContain('<b>mosque');
      expect(box).not.toMatch(/<br>\s*,\s*<br>/);
      expect(box).not.toMatch(/<br>\s*<br>/);
    }
  );
});
