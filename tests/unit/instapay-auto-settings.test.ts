/** INSTAPAY-AUTO-1 S2: the kill switches (D1 system_settings, no cache, fail closed) and the new table's migration. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../apps/api/src/middleware/security', async importOriginal => ({
  ...(await importOriginal<object>()),
  auditLog: h.audit,
}));

import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';
import {
  AUTO_MODE_KEY,
  getAutoMode,
  isStoreAutoEnabled,
  listDisabledStores,
  setAutoMode,
  setStoreAuto,
} from '../../apps/api/src/services/billing/instapay-auto-settings';
import { A, B, buildWorld, type World } from '../helpers/instapay-auto-world';

let w: World;
beforeEach(() => {
  h.audit.mockClear();
  registerPlatformRouter();
  w = buildWorld();
});

describe('S2 switches', () => {
  it('the mode defaults to off and a write is visible to the very next read (no cache lag)', async () => {
    expect(await getAutoMode()).toBe('off');
    await setAutoMode('shadow', 'ahmad', 'start shadowing now');
    expect(await getAutoMode()).toBe('shadow');
    await setAutoMode('off', 'ahmad', 'kill switch drill');
    expect(await getAutoMode()).toBe('off');
  });
  it('a garbage stored mode reads as off (fail closed)', async () => {
    w.db
      .prepare(
        `INSERT INTO system_settings (id, key, value) VALUES ('m', ?, '{"mode":"yes please"}')`
      )
      .run(AUTO_MODE_KEY);
    expect(await getAutoMode()).toBe('off');
  });
  it('a store is enabled until switched off; switching needs a 5+ character reason; both writes are audited', async () => {
    expect(await isStoreAutoEnabled(A)).toBe(true);
    await expect(setStoreAuto(A, false, 'ahmad', 'no')).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
    });
    await expect(setAutoMode('live', 'ahmad', 'x')).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
    });
    await setStoreAuto(A, false, 'ahmad', 'money dispute on this store');
    expect(await isStoreAutoEnabled(A)).toBe(false);
    expect(await isStoreAutoEnabled(B)).toBe(true); // another store is untouched
    expect(await listDisabledStores()).toEqual([expect.objectContaining({ storeId: A })]);
    await setStoreAuto(A, true, 'ahmad', 'dispute settled today');
    expect(await isStoreAutoEnabled(A)).toBe(true);
    expect(h.audit.mock.calls.map(c => (c[0] as { action: string }).action)).toEqual([
      'billing.instapay_auto_store_toggled',
      'billing.instapay_auto_store_toggled',
    ]);
  });
  it('an unparsable per-store row means disabled (fail closed)', async () => {
    w.db
      .prepare(`INSERT INTO system_settings (id, key, value) VALUES ('s', ?, '"garbage"')`)
      .run(`instapay.auto_confirm.store.${B}`);
    expect(await isStoreAutoEnabled(B)).toBe(false);
  });
});

describe('S2 table', () => {
  it('claim_id and idempotency_key are unique and the state is a column the cascade removes with the store', () => {
    const ins = (id: string, claim: string, key: string) =>
      w.db
        .prepare(
          `INSERT INTO instapay_auto_confirmations (id, store_id, claim_id, receipt_id, reasons, expected_amount_minor, is_first_payment, idempotency_key) VALUES (?, ?, ?, 'r', '[]', 5000, 1, ?)`
        )
        .run(id, A, claim, key);
    ins('1', 'c1', 'k1');
    expect(() => ins('2', 'c1', 'k2')).toThrow(/UNIQUE/);
    expect(() => ins('3', 'c3', 'k1')).toThrow(/UNIQUE/);
    w.db.prepare('DELETE FROM stores WHERE id = ?').run(A);
    expect(w.db.prepare('SELECT COUNT(*) n FROM instapay_auto_confirmations').get()).toEqual({
      n: 0,
    });
  });
});
