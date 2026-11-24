/**
 * Ported from tests/integration/warehouse-crud.test.ts ("blocks deactivating the last active warehouse"; the Postgres original is
 * deleted). The real WarehouseService runs on the StoreDO schema (node:sqlite through prisma-lite, the wiring of
 * product-3d-models-do.test.ts): the last active warehouse cannot be deactivated or switched off (400 WAREHOUSE_LAST_ACTIVE, the row
 * stays active), while one with another active warehouse beside it can, and loses its default flag.
 */
import { describe, it, expect, vi } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

const raw = openSqlite();
const lite = createPrismaLite(META, nodeSqlRunner(raw), 'store-do', { unscoped: true }) as any;

vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeDb: async () => lite,
  storeWriter: async () => lite,
}));

import { WarehouseService } from '../../apps/api/src/services/warehouse.service';

let seq = 0;
let STORE = '';
// one store per test: the count of other active warehouses is per store
function seed(spec: Array<{ active: boolean; isDefault?: boolean }>) {
  const n = ++seq;
  STORE = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return spec.map((w, i) => {
    const id = `wh-${n}-${i}`;
    raw
      .prepare(
        `INSERT INTO warehouses (id, store_id, name, code, is_default, is_active, priority) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, STORE, `W${i}`, `C${n}${i}`, w.isDefault ? 1 : 0, w.active ? 1 : 0, i);
    return id;
  });
}
const row = (id: string) =>
  raw.prepare(`SELECT is_active a, is_default d FROM warehouses WHERE id = ?`).get(id) as {
    a: number;
    d: number;
  };

describe('the last active warehouse (store DB)', () => {
  it('cannot be deactivated: 400 WAREHOUSE_LAST_ACTIVE and the row stays active and default', async () => {
    const [main, south] = seed([{ active: true, isDefault: true }, { active: false }]);
    await expect(WarehouseService.deactivateWarehouse(STORE, main!)).rejects.toMatchObject({
      statusCode: 400,
      code: 'WAREHOUSE_LAST_ACTIVE',
    });
    expect(row(main!)).toEqual({ a: 1, d: 1 });
    expect(row(south!).a).toBe(0);
  });

  it('cannot be switched off through an update either (the default one, with no other active)', async () => {
    const [main] = seed([{ active: true, isDefault: true }]);
    await expect(
      WarehouseService.updateWarehouse(STORE, main!, { isActive: false })
    ).rejects.toMatchObject({ code: 'WAREHOUSE_LAST_ACTIVE' });
    expect(row(main!).a).toBe(1);
  });

  it('with another active warehouse it deactivates, loses the default flag, and the other one is now the last', async () => {
    const [main, south] = seed([{ active: true, isDefault: true }, { active: true }]);
    await WarehouseService.deactivateWarehouse(STORE, south!);
    expect(row(south!)).toEqual({ a: 0, d: 0 });
    await expect(WarehouseService.deactivateWarehouse(STORE, main!)).rejects.toMatchObject({
      code: 'WAREHOUSE_LAST_ACTIVE',
    });
  });
});
