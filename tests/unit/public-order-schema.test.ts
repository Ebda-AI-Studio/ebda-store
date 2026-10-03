/**
 * Regression: public checkout order validation contract (the P0 that failed in
 * front of a client on 2026-06-09).
 *
 * Egypt addresses have no "city" (the locality is the area/district, sent as
 * `state`), and the email field is optional. The storefront checkout form sends
 * `city: ''` and frequently `email: ''`. An earlier `shippingAddressSchema`
 * required `city` (`.min(1)`) and treated email as required-or-undefined, so a
 * normal KW order 400'd ("خطأ في الدفع" → bounced back to the info step) and
 * never reached the payment page. These tests lock the relaxed contract so the
 * regression can't silently come back via a schema edit.
 */
import { describe, it, expect } from 'vitest';
import { shippingAddressSchema, createOrderSchema } from '@api/routes/public.routes';

// A realistic Egypt checkout payload as the storefront actually sends it.
const kwAddress = {
  firstName: 'Ahmad',
  lastName: 'Sharaf',
  address1: 'Block 4, Street 1, House 10',
  city: '', // KW model: city is always blank
  state: 'Hawally', // legacy: area/district used to live here
  country: 'EG',
  phone: '+96512345678',
};

// Extended payload with the new governorate + sub-area fields.
const kwAddressWithGovernorates = {
  ...kwAddress,
  governorate: 'Hawally',
  governorateAr: 'حولي',
  area: 'Salmiya',
  areaAr: 'السالمية',
};

describe('public checkout order schema (KW contract regression)', () => {
  describe('shippingAddressSchema', () => {
    it('accepts an empty city (KW addresses have none)', () => {
      const r = shippingAddressSchema.safeParse(kwAddress);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.city).toBe('');
    });

    it('accepts a completely omitted email', () => {
      const r = shippingAddressSchema.safeParse(kwAddress);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBeUndefined();
    });

    it("treats an empty-string email as 'not given' (not an invalid email)", () => {
      const r = shippingAddressSchema.safeParse({ ...kwAddress, email: '' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBeUndefined();
    });

    it('treats a whitespace-only email as not given', () => {
      const r = shippingAddressSchema.safeParse({ ...kwAddress, email: '   ' });
      expect(r.success).toBe(true);
    });

    it('still accepts and keeps a valid email when provided', () => {
      const r = shippingAddressSchema.safeParse({ ...kwAddress, email: 'buyer@example.com' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBe('buyer@example.com');
    });

    it('still rejects a malformed email (validation not disabled, just optional)', () => {
      const r = shippingAddressSchema.safeParse({ ...kwAddress, email: 'not-an-email' });
      expect(r.success).toBe(false);
    });

    it('still requires the genuinely-required fields (firstName/address1/country)', () => {
      expect(shippingAddressSchema.safeParse({ ...kwAddress, firstName: '' }).success).toBe(false);
      expect(shippingAddressSchema.safeParse({ ...kwAddress, address1: '' }).success).toBe(false);
      const { country: _omit, ...noCountry } = kwAddress;
      expect(shippingAddressSchema.safeParse(noCountry).success).toBe(false);
    });

    it('passes through governorate+governorateAr+area+areaAr (not stripped)', () => {
      const r = shippingAddressSchema.safeParse(kwAddressWithGovernorates);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.governorate).toBe('Hawally');
        expect(r.data.governorateAr).toBe('حولي');
        expect(r.data.area).toBe('Salmiya');
        expect(r.data.areaAr).toBe('السالمية');
      }
    });
  });

  describe('createOrderSchema', () => {
    it('accepts a full KW order (blank city + no email) with a payment method', () => {
      const r = createOrderSchema.safeParse({
        shippingAddress: kwAddress,
        paymentMethod: 'myfatoorah',
      });
      expect(r.success).toBe(true);
    });

    it('accepts an optional ar/en locale and rejects an unknown locale', () => {
      expect(
        createOrderSchema.safeParse({
          shippingAddress: kwAddress,
          paymentMethod: 'knet',
          locale: 'ar',
        }).success
      ).toBe(true);
      expect(
        createOrderSchema.safeParse({
          shippingAddress: kwAddress,
          paymentMethod: 'knet',
          locale: 'fr',
        }).success
      ).toBe(false);
    });

    it('requires a non-empty payment method', () => {
      expect(
        createOrderSchema.safeParse({ shippingAddress: kwAddress, paymentMethod: '' }).success
      ).toBe(false);
    });
  });
});
