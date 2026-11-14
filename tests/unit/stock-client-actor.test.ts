/**
 * INV-AUDIT-3: the stock ops that write a movement row take the ACTOR from the request's ambient scope when the caller
 * did not name one, so the variant grid, the warehouse set, the product bulk edit and the import never write an actor-less row
 * for a signed-in admin. A cron has no scope user: the row then carries no actor (a system change), never a wrong one.
 */
import { describe, expect, it } from 'vitest';
import { makeStockClient } from '@api/lib/repo-factory';
import { runInStoreScope } from '@ebda/database';

const STORE = '11111111-1111-4111-8111-111111111111';

const seen: Array<{ op: string; args: any }> = [];
const client = makeStockClient(async (op, args) => {
  seen.push({ op, args });
  return {};
});

describe('stock client actor', () => {
  it('fills userId from the ambient scope for every movement-writing op', async () => {
    seen.length = 0;
    await runInStoreScope(
      STORE,
      async () => {
        await client.setVariantInventory({ productId: 'p', updates: [] });
        await client.setWarehouseStock({ warehouseId: 'w', productId: 'p', quantity: 1 });
        await client.adjustWarehouseStock({ warehouseId: 'w', productId: 'p', delta: 1 });
        await client.bulkSetInventory({ productIds: ['p'], mode: 'set', value: 1 });
      },
      'admin-1'
    );
    expect(seen.map(s => s.args.userId)).toEqual(Array(4).fill('admin-1'));
  });

  it('an explicit actor wins, and a job with no scope user stays actor-less', async () => {
    seen.length = 0;
    await runInStoreScope(
      STORE,
      () =>
        client.bulkSetInventory({ productIds: ['p'], mode: 'set', value: 1, userId: 'explicit' }),
      'admin-1'
    );
    await client.bulkSetInventory({ productIds: ['p'], mode: 'set', value: 1 });
    expect(seen[0].args.userId).toBe('explicit');
    expect(seen[1].args.userId).toBeUndefined();
  });
});
