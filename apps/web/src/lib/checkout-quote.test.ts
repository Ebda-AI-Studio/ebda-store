import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildQuoteRequest,
  quoteKey,
  freshQuote,
  expectedTotalFor,
  expectedTotalToSend,
  priceChangedCopy,
  type OrderQuote,
} from './checkout-quote';

const inputs = {
  area: 'Nasr City',
  governorate: 'Cairo',
  country: 'Egypt',
  phone: ' 01012345678 ',
  email: '',
  selectedProvider: 'cod:cash',
  couponCode: 'SAVE10',
  pointsToRedeem: 0,
};
const lines = [{ id: 'l1', quantity: 10, price: 8500 }];
const quote = (total: number): OrderQuote => ({
  subtotal: 85000,
  discount: 0,
  shipping: 3000,
  codFee: 0,
  tax: 0,
  total,
  taxIncludedInPrice: false,
  lines: [],
});

describe('buildQuoteRequest', () => {
  it('sends only what can change the total, trims, and keeps just the provider part', () => {
    expect(buildQuoteRequest(inputs)).toEqual({
      shippingAddress: {
        area: 'Nasr City',
        governorate: 'Cairo',
        country: 'Egypt',
        phone: '01012345678',
        email: undefined,
      },
      paymentMethod: 'cod',
      couponCode: 'SAVE10',
      pointsToRedeem: undefined,
    });
  });
  it('never carries a price: the body has no price / total / unitPrice key', () => {
    expect(JSON.stringify(buildQuoteRequest(inputs))).not.toMatch(/price|total/i);
  });
});

describe('the held quote is only valid for the exact inputs and cart it was priced for', () => {
  const key = quoteKey(inputs, lines);
  it('is fresh for the same key and gives the server total as expectedTotal', () => {
    const held = { key, quote: quote(88000) };
    expect(freshQuote(held, key)).toBe(held.quote);
    expect(expectedTotalFor(held, key)).toBe(88000);
  });
  it('QA-COUPON-1: expectedTotal is ALWAYS sent: the fresh quote total, else the total on screen (coupon applied: 42000)', () => {
    const held = { key, quote: quote(42000) };
    expect(expectedTotalToSend(held, key, 51000)).toBe(42000);
    // quote failed / in flight / stale: the shown total (with the coupon) is still sent, never undefined
    expect(expectedTotalToSend(null, key, 42000)).toBe(42000);
    expect(expectedTotalToSend(held, quoteKey({ ...inputs, couponCode: null }, lines), 42000)).toBe(
      42000
    );
    expect(Number.isInteger(expectedTotalToSend(null, key, 41999.6))).toBe(true);
  });
  it.each([
    ['area', { ...inputs, area: 'Maadi' }, lines],
    ['provider (COD fee)', { ...inputs, selectedProvider: 'paymob:card' }, lines],
    ['coupon', { ...inputs, couponCode: null }, lines],
    ['points', { ...inputs, pointsToRedeem: 100 }, lines],
    ['cart quantity', inputs, [{ id: 'l1', quantity: 9, price: 9000 }]],
  ])(
    'is stale when the %s changes: no expectedTotal is sent for a number the buyer did not see',
    (_n, i, l) => {
      const held = { key, quote: quote(88000) };
      expect(expectedTotalFor(held, quoteKey(i, l))).toBeUndefined();
    }
  );
  it('a nonce bump (after PRICE_CHANGED) makes the held quote stale so a new one is fetched', () => {
    const held = { key, quote: quote(88000) };
    expect(expectedTotalFor(held, quoteKey(inputs, lines, 1))).toBeUndefined();
  });
  it('no quote held -> nothing to send', () => {
    expect(expectedTotalFor(null, key)).toBeUndefined();
  });
});

describe('PRICE_CHANGED copy', () => {
  const fmt = (m: number) => `${(m / 100).toFixed(2)} EGP`;
  it('states the new total in English and Arabic with Latin digits and asks for confirmation', () => {
    const en = priceChangedCopy({ total: 100000 }, fmt, (e, _a) => e);
    const ar = priceChangedCopy({ total: 100000 }, fmt, (_e, a) => a);
    expect(en).toContain('1000.00 EGP');
    expect(en).toMatch(/confirm/i);
    expect(ar).toContain('1000.00 EGP');
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toMatch(/[٠-٩]/); // NUMERALS-1
  });
  it('falls back to figure-less copy when the server sent no total', () => {
    expect(priceChangedCopy({}, fmt, (e, _a) => e)).not.toMatch(/EGP/);
    expect(priceChangedCopy(null, fmt, (e, _a) => e)).toMatch(/new total/i);
  });
});

/**
 * The wiring that no DOM harness in this repo can render, pinned on the source (same convention as coupon-quote-basis.test.ts):
 * the checkout holds a SERVER quote, shows its figures once fresh, and sends its total as `expectedTotal`.
 */
describe('CheckoutClient wiring (I-1)', () => {
  const src = readFileSync(join(__dirname, '../app/checkout/CheckoutClient.tsx'), 'utf8');
  it('the createOrder request body carries expectedTotal (held server quote, else the shown total; QA-COUPON-1)', () => {
    expect(src).toMatch(
      /expectedTotal:\s*expectedTotalToSend\(heldQuote,\s*currentQuoteKey,\s*total\)/
    );
  });
  it('fetches the quote from the server on the payment step and never prices the confirmed total in the browser', () => {
    expect(src).toMatch(/api\s*\.quoteOrder\(buildQuoteRequest\(quoteInputs\)\)/);
    expect(src).toMatch(/const total = serverQuote \? serverQuote\.total : localTotal/);
  });
  it('Place order is disabled while the quote is loading', () => {
    expect(src).toMatch(/isProcessing=\{[^}]*quotePending[^}]*\}/);
  });
  it('PRICE_CHANGED keeps the buyer on the payment step, drops the held quote and names the new total', () => {
    const block = src.slice(src.indexOf("case 'PRICE_CHANGED'"), src.indexOf("case 'BELOW_MOQ'"));
    expect(block).toContain('setHeldQuote(null)');
    expect(block).toContain('setQuoteNonce');
    expect(block).toContain('priceChangedCopy');
    expect(block).not.toContain('setStep(1)');
  });
  it('the displayed discount / shipping / COD fee / subtotal come from the fresh quote', () => {
    expect(src).toMatch(/subtotal=\{shownSubtotal\}/);
    expect(src).toMatch(/discount=\{shownDiscount\}/);
    expect(src).toMatch(/shipping=\{shownShipping\}/);
    expect(src).toMatch(/codFee=\{shownCodFee\}/);
  });
});
