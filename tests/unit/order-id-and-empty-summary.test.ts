import { describe, expect, it } from 'vitest';
import { isOrderId } from '../../apps/admin/src/lib/order-id';
import { isEmptyAnswerEngineSummary } from '../../apps/admin/src/app/stores/[id]/answer-engine/summary-empty';

describe('order page id gate (STORE-QA-33)', () => {
  it('a uuid is an order id; a guessed sub-path or nothing is not', () => {
    expect(isOrderId('3f2a9c1e-5b7d-4e21-9a0c-1d2e3f4a5b6c')).toBe(true);
    expect(isOrderId('3F2A9C1E-5B7D-4E21-9A0C-1D2E3F4A5B6C')).toBe(true);
    for (const bad of [
      'invoices',
      'new',
      '123',
      '3f2a9c1e-5b7d-4e21-9a0c-1d2e3f4a5b6',
      '',
      undefined,
      null,
    ])
      expect(isOrderId(bad as string | undefined)).toBe(false);
  });
});

describe('answer-engine empty state (STORE-QA-34)', () => {
  it('is empty only when engines, trend and prompts are all empty', () => {
    expect(isEmptyAnswerEngineSummary({ engines: [], trend: [], prompts: [] })).toBe(true);
    expect(isEmptyAnswerEngineSummary({ engines: [1], trend: [], prompts: [] })).toBe(false);
    expect(isEmptyAnswerEngineSummary({ engines: [], trend: [1], prompts: [] })).toBe(false);
    expect(isEmptyAnswerEngineSummary({ engines: [], trend: [], prompts: [1] })).toBe(false);
  });
});
