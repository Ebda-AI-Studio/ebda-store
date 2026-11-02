// Ruling CF-LEDGER-1: the DO ledger copies the provider -> cash account map by value; this pins the copies equal.
import { describe, expect, it } from 'vitest';
import { PROVIDER_TO_CASH_CODE as DO_MAP } from '../../packages/repo/src/do/ledger';
import { PROVIDER_TO_CASH_CODE as API_MAP } from '../../apps/api/src/services/accounting/posting/order-posting';

describe('DO ledger cash account map', () => {
  it('equals the API posting map', () => {
    expect(DO_MAP).toEqual(API_MAP);
  });
});
