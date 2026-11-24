/** QA98-ALIAS-1: distinct customers and repeat buyers fold guests through the ONE customer grouping, on both backends' identity rows. */
import { describe, it, expect } from 'vitest';
import { CustomerGroups } from '@api/lib/customer-groups';
import { distinctCustomersFrom, repeatBuyersFrom } from '@api/lib/buyer-counts';

const ids = [
  { key: '+20 100 000 0001', email: '', phone: '+20 100 000 0001' },
  { key: 'b@x.test', email: 'b@x.test', phone: '01000000001' },
  { key: 'solo@x.test', email: 'solo@x.test', phone: '' },
];
const rows = [
  { customerId: null, email: null, phone: '+20 100 000 0001', n: 1 }, // phone-only order of guest B
  { customerId: null, email: 'b@x.test', phone: '01000000001', n: 1 },
  { customerId: null, email: 'solo@x.test', phone: null, n: 1 },
  { customerId: 'user-1', email: null, phone: null, n: 3 },
  { customerId: null, email: null, phone: null, n: 2 }, // two contact-less guest orders: two customers
];

describe('customer counts through the group', () => {
  it('counts the phone-only and the email order of one guest as ONE customer', () => {
    const g = new CustomerGroups(ids);
    expect(distinctCustomersFrom(rows, g)).toBe(1 + 1 + 1 + 2);
    expect(repeatBuyersFrom(rows, g)).toEqual({ repeat: 2, buyers: 3 }); // guest B (2 orders), user-1 (3); solo has 1
  });

  it('gives the same answer whatever order the identities and rows arrive in', () => {
    const a = new CustomerGroups(ids);
    const b = new CustomerGroups([...ids].reverse());
    expect(distinctCustomersFrom([...rows].reverse(), b)).toBe(distinctCustomersFrom(rows, a));
    expect(repeatBuyersFrom([...rows].reverse(), b)).toEqual(repeatBuyersFrom(rows, a));
  });
});
