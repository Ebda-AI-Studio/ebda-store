import { describe, it, expect } from 'vitest';
import { serializeEtaValue, receiptUuid } from '@api/lib/eta/serialize';

describe('ETA serialization', () => {
  it('uppercases names, quotes simple values and keeps numbers verbatim', () => {
    expect(serializeEtaValue({ amount: 0.5, name: 'x' })).toBe('"AMOUNT""0.5""NAME""x"');
  });
  it('recurses objects unquoted', () => {
    expect(serializeEtaValue({ a: { b: 'c' } })).toBe('"A""B""c"');
  });
  it('repeats the array name before every element', () => {
    expect(serializeEtaValue({ taxableItems: [{ amount: 1 }, { amount: 2 }] })).toBe(
      '"TAXABLEITEMS""TAXABLEITEMS""AMOUNT""1""TAXABLEITEMS""AMOUNT""2"'
    );
  });
  it('uuid ignores the incoming uuid value and is 64 hex chars', () => {
    const r = { header: { uuid: 'abc', n: 1 } };
    const a = receiptUuid(r);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptUuid({ header: { uuid: 'zzz', n: 1 } })).toBe(a);
    expect(receiptUuid({ header: { uuid: '', n: 2 } })).not.toBe(a);
  });
});
