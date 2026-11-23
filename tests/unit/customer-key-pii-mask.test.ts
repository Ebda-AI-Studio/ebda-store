/**
 * The shared customer key (Customers page ⇄ RFM rollup) and the contact
 * masking used by the merchant MCP read tools.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { customerKeyOf, isGuestOrder, rfmKeyFor } from '@api/lib/customer-key';
import { maskAddress, maskEmail, maskPhone, redactFreeText } from '@api/lib/pii-mask';
import { summarizeFunnel } from '@api/services/accounting/funnel-report.service';
import { couponState, customerRefOf } from '@api/mcp/tools/admin-read-customers-marketing.tools';

describe('customerKeyOf — the Customers-page grouping', () => {
  it('uses the registered user id first', () => {
    expect(
      customerKeyOf({ customerId: 'u1', shippingAddress: { email: 'a@x.test', phone: '1' } })
    ).toBe('u1');
    expect(customerKeyOf({ customer: { id: 'u2' }, shippingAddress: {} })).toBe('u2');
  });

  it('keys a guest by lowercased email, else phone', () => {
    expect(customerKeyOf({ customerId: null, shippingAddress: { email: 'A@X.test' } })).toBe(
      'a@x.test'
    );
    expect(customerKeyOf({ customerId: null, shippingAddress: { phone: '+96550001234' } })).toBe(
      '+96550001234'
    );
  });

  it('one email with two phones is ONE customer (the old RFM key split it in two)', () => {
    const a = customerKeyOf({ shippingAddress: { email: 'g@x.test', phone: '111' } });
    const b = customerKeyOf({ shippingAddress: { email: 'g@x.test', phone: '222' } });
    expect(a).toBe(b);
  });

  it('is null for a contact-less guest', () => {
    expect(customerKeyOf({ customerId: null, shippingAddress: { firstName: 'x' } })).toBeNull();
    expect(customerKeyOf({ customerId: null, shippingAddress: null })).toBeNull();
    expect(isGuestOrder({ customerId: null })).toBe(true);
    expect(isGuestOrder({ customerId: 'u1' })).toBe(false);
  });
});

describe('rfmKeyFor', () => {
  it('keeps a registered id and hashes a guest key (no plain contact at rest)', () => {
    expect(rfmKeyFor('u1', false)).toBe('u1');
    const k = rfmKeyFor('g@x.test', true);
    expect(k).toMatch(/^GUEST:[0-9a-f]{64}$/);
    expect(k).not.toContain('g@x.test');
    // Stable: the Customers page and the RFM rollup must derive the same key.
    expect(rfmKeyFor('g@x.test', true)).toBe(k);
  });

  // issue 2242 — the guest key leaves the platform as the MCP `customerRef`.
  // An UNKEYED sha256 of an 8-digit Egypt mobile is reversible by brute
  // force; the key is now an HMAC under a server-derived secret. Mutation-
  // proof: reverting rfmKeyFor to createHash('sha256') reddens this.
  it('is NOT a plain (unkeyed) sha256 of the contact, so it cannot be brute-forced', () => {
    for (const contact of ['g@x.test', '+96550001111', '50001111']) {
      const plain = `GUEST:${createHash('sha256').update(contact).digest('hex')}`;
      expect(rfmKeyFor(contact, true)).not.toBe(plain);
    }
  });
});

describe('maskPhone / maskEmail', () => {
  it('masks to the documented shapes', () => {
    expect(maskPhone('+96512341234')).toBe('+965 ****1234');
    expect(maskPhone('9876 5432')).toBe('****5432');
    expect(maskPhone('123')).toBe('****');
    expect(maskPhone('')).toBeNull();
    expect(maskPhone(null)).toBeNull();
    expect(maskEmail('jane@example.com')).toBe('j***@example.com');
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail(undefined)).toBeNull();
  });

  it('never returns the middle digits or the local part', () => {
    const p = maskPhone('+96555501234')!;
    expect(p).not.toContain('555');
    expect(maskEmail('secretname@x.test')).not.toContain('ecretname');
  });
});

describe('maskAddress', () => {
  it('drops street-level keys, masks contact, keeps locality', () => {
    const out = maskAddress({
      firstName: 'Sara',
      address1: 'Block 4, Street 12, House 7',
      address2: 'Floor 2',
      block: '4',
      street: '12',
      area: 'Salmiya',
      governorate: 'Hawally',
      country: 'EG',
      phone: '+96550001234',
      email: 'sara@x.test',
    })!;
    expect(out).toEqual({
      firstName: 'Sara',
      area: 'Salmiya',
      governorate: 'Hawally',
      country: 'EG',
      phone: '+965 ****1234',
      email: 's***@x.test',
    });
    expect(JSON.stringify(out)).not.toMatch(/Street 12|House 7|50001234|sara@/);
  });

  it('returns null for a non-object', () => {
    expect(maskAddress(null)).toBeNull();
    expect(maskAddress('x')).toBeNull();
  });
});

describe('customerRefOf', () => {
  it('never exposes a guest contact as the reference', () => {
    expect(customerRefOf({ id: 'u1', isGuest: false })).toBe('u1');
    const ref = customerRefOf({ id: 'g@x.test', isGuest: true });
    expect(ref).toBe(rfmKeyFor('g@x.test', true));
    expect(ref).not.toContain('@');
    // A contact-less guest row is keyed by order id — no PII to hide.
    expect(customerRefOf({ id: 'guest:ord-1', isGuest: true })).toBe('guest:ord-1');
  });
});

describe('couponState', () => {
  const base = { isActive: true, startsAt: null, expiresAt: null, usageLimit: null, usageCount: 0 };
  const now = new Date('2026-09-30T00:00:00Z');
  it('derives the lifecycle state', () => {
    expect(couponState(base, now)).toBe('active');
    expect(couponState({ ...base, isActive: false }, now)).toBe('inactive');
    expect(couponState({ ...base, startsAt: new Date('2026-10-01') }, now)).toBe('scheduled');
    expect(couponState({ ...base, expiresAt: new Date('2026-09-01') }, now)).toBe('expired');
    expect(couponState({ ...base, usageLimit: 5, usageCount: 5 }, now)).toBe('exhausted');
  });
});

describe('summarizeFunnel — ruling AUD-2', () => {
  const day = (d: string, v: number, c: number, o: number) => ({
    periodDate: new Date(`${d}T00:00:00Z`),
    productViews: v,
    cartsCreated: c,
    cartItemsAdded: c,
    ordersCompleted: o,
    revenueFils: o * 1000,
  });

  it('reports guest-uncapturable stages as null with a reason, never 0', () => {
    const f = summarizeFunnel([day('2026-09-28', 100, 10, 2), day('2026-09-29', 100, 10, 3)], 7);
    expect(f.stages).toEqual({
      productViews: 200,
      cartsCreated: 20,
      cartItemsAdded: 20,
      checkoutsStarted: null,
      ordersCompleted: 5,
    });
    expect(f.rates).toEqual({ viewToCart: 0.1, cartToOrder: 0.25, viewToOrder: 0.025 });
    expect(f.unavailable.map(u => u.stage)).toEqual(['checkoutsStarted', 'ordersAbandoned']);
    expect(f.unavailable.every(u => u.reason.length > 20)).toBe(true);
    expect(f.days.every(d => d.checkoutsStarted === null && d.ordersAbandoned === null)).toBe(true);
  });

  it('is unknown (null), not zero, when the rollup has no rows', () => {
    const f = summarizeFunnel([], 30);
    expect(f.daysCovered).toBe(0);
    expect(Object.values(f.stages).every(v => v === null)).toBe(true);
    expect(f.rates).toEqual({ viewToCart: null, cartToOrder: null, viewToOrder: null });
    expect(f.revenueFils).toBeNull();
  });

  it('a zero denominator is a null rate', () => {
    const f = summarizeFunnel([day('2026-09-28', 0, 0, 0)], 7);
    expect(f.stages.productViews).toBe(0);
    expect(f.rates.viewToCart).toBeNull();
  });
});

describe('redactFreeText (issue 2244 — shopper-authored order notes)', () => {
  it('redacts phone-shaped digit runs, with or without separators or a +', () => {
    expect(redactFreeText('call 99998888 at the gate')).toBe('call [phone] at the gate');
    expect(redactFreeText('call 9999 8888')).toBe('call [phone]');
    expect(redactFreeText('+965-5000-1234 please')).toBe('[phone] please');
  });

  it('redacts email addresses', () => {
    expect(redactFreeText('receipt to Sara.Ali@example.com thanks')).toBe(
      'receipt to [email] thanks'
    );
  });

  it('keeps dates, order references and 6-digit building numbers (PR 2301 audit)', () => {
    expect(redactFreeText('deliver on 2026-09-30 please')).toBe('deliver on 2026-09-30 please');
    expect(redactFreeText('re ORD-20260930-001')).toBe('re ORD-20260930-001');
    expect(redactFreeText('building 123456')).toBe('building 123456');
    expect(redactFreeText('2026-09-30, call 99998888')).toBe('2026-09-30, call [phone]');
  });

  it('keeps short numbers and ordinary words (block 4, house 12, 2 boxes)', () => {
    expect(redactFreeText('Block 4, house 12, 2 boxes')).toBe('Block 4, house 12, 2 boxes');
  });

  it('is null for empty input — unknown, not ""', () => {
    expect(redactFreeText(null)).toBeNull();
    expect(redactFreeText('   ')).toBeNull();
  });
});
