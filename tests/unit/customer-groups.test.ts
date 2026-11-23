/** Ruling QA98-ALIAS-1: one deterministic, order-independent, transitive customer grouping. */
import { describe, it, expect } from 'vitest';
import { CustomerGroups } from '@api/lib/customer-groups';

const guest = (email: string | null, phone: string | null) => ({
  customerId: null,
  shippingAddress: { ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
});

const orders = [
  guest(null, '+20 100 000 0001'), // phone only
  guest('B@x.test', '01000000001'), // email + same phone, spelled differently
  guest('b@x.test', '01000000002'), // same email, a second phone
  guest(null, '0100 000 0002'), // phone-only, the second phone
  guest('other@x.test', '01099999999'), // unrelated
  guest(null, '123'), // short phone: only itself
];

function groupsOf(list: typeof orders) {
  const g = CustomerGroups.fromOrders(list);
  return [...new Set(list.map(o => g.keyOf(o)))].sort();
}

describe('CustomerGroups', () => {
  it('links by shared email OR canonical phone, transitively, row id = smallest member key', () => {
    const g = CustomerGroups.fromOrders(orders);
    const keys = orders.map(o => g.keyOf(o));
    // orders 0..3 are one person: phone-only 0001, email+0001, email+0002, phone-only 0002
    expect(new Set(keys.slice(0, 4)).size).toBe(1);
    const members = g.memberKeysOf(keys[0]!);
    expect(members).toEqual([...members].sort());
    expect(keys[0]).toBe(members[0]);
    expect(members).toEqual(
      expect.arrayContaining(['b@x.test', '+20 100 000 0001', '0100 000 0002'])
    );
    expect(keys[4]).toBe('other@x.test');
    expect(keys[5]).toBe('123');
  });

  it('is order independent: phone-only order first, last, or shuffled gives identical groups', () => {
    const base = CustomerGroups.fromOrders(orders);
    const expected = orders.map(o => base.keyOf(o));
    for (const perm of [
      [...orders].reverse(),
      [orders[3], orders[0], orders[2], orders[5], orders[1], orders[4]],
    ]) {
      const g = CustomerGroups.fromOrders(perm);
      expect(orders.map(o => g.keyOf(o))).toEqual(expected);
    }
    expect(groupsOf([...orders].reverse())).toEqual(groupsOf(orders));
  });

  it('never merges registered customers or different unrelated guests', () => {
    const reg = { customerId: 'u-1', shippingAddress: { email: 'b@x.test', phone: '01000000001' } };
    const g = CustomerGroups.fromOrders([reg, ...orders]);
    expect(g.keyOf(reg)).toBe('u-1');
    expect(g.keyOf(orders[4])).not.toBe(g.keyOf(orders[0]));
  });

  it('a guest with no contact has no group key (caller gives it guest:<orderId>)', () => {
    const none = { customerId: null, shippingAddress: {} };
    expect(CustomerGroups.fromOrders([none]).keyOf(none)).toBeNull();
  });

  it('the list row key, the RFM key input, the detail lookup and consent members all resolve through one group', () => {
    const g = CustomerGroups.fromOrders(orders);
    const rowKey = g.keyOf(orders[0])!;
    // list + RFM: every order of the person has the same row key (RFM hashes exactly this value)
    expect(orders.slice(0, 4).map(o => g.keyOf(o))).toEqual(Array(4).fill(rowKey));
    // detail: any stored spelling a member order carries opens the same group
    const members = g.memberKeysOf(rowKey);
    for (const m of members) expect(g.memberKeysOf(m)).toEqual(members);
    expect(g.groupOfMemberKey('b@x.test')!.key).toBe(rowKey);
    // consent / erasure: the group exposes every email and phone the person used
    const grp = g.groupOfMemberKey(rowKey)!;
    expect(grp.emails).toEqual(['b@x.test']);
    expect(grp.phones).toHaveLength(4);
    // a contact in any spelling finds the group
    expect(g.groupsOfContact({ phone: '0100-000-0002' })[0].key).toBe(rowKey);
    expect(g.groupsOfContact({ email: ' B@X.test ' })[0].key).toBe(rowKey);
    expect(g.keyOfContact({ email: null, phone: '+20 100-000-0002' })).toBe(rowKey); // a spelling no order used
    expect(g.keyOfContact({ email: 'new@x.test', phone: null })).toBe('new@x.test');
  });
});
