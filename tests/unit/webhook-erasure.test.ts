/**
 * M10: a customer erasure also strips contact data from the webhook delivery log (the stored copies of
 * payloads that opted into customer contact). Payloads already delivered to the merchant's server
 * cannot be recalled: Ruling WH-7.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redactWebhookCustomerData } from '../../apps/api/src/services/webhook-erasure';

const fakeTx = () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return 3;
    }),
  };
};

describe('redactWebhookCustomerData', () => {
  it("removes data.customer from this store's stored deliveries for the erased orders and email", async () => {
    const tx = fakeTx();
    const n = await redactWebhookCustomerData(tx as never, {
      storeId: 's1',
      orderIds: ['o1', 'o2'],
      email: 'A@x.co',
    });
    expect(n).toBe(3);
    const { sql, values } = tx.calls[0];
    expect(sql).toMatch(/UPDATE webhook_deliveries/);
    expect(sql).toMatch(/store_id = \?/);
    expect(sql).toMatch(/- 'customer'/);
    expect(sql).toMatch(/payload #>> '\{data,order,id\}' = ANY/);
    expect(sql).toMatch(/lower\(payload #>> '\{data,customer,email\}'\) = \?/);
    expect(values).toContain('s1');
    expect(values).toContain('a@x.co');
    expect(values).toContainEqual(['o1', 'o2']);
  });
  it('does nothing when there is nothing to match on', async () => {
    const tx = fakeTx();
    expect(
      await redactWebhookCustomerData(tx as never, { storeId: 's1', orderIds: [], email: null })
    ).toBe(0);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('eraseAccount calls it BEFORE the orders lose their customer link', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/api/src/services/auth.service.ts'),
      'utf8'
    );
    const call = src.indexOf('redactWebhookCustomerData(');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(src.indexOf('shippingAddress: anonymizedAddressJson'));
  });
});
