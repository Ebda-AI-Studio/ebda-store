/**
 * The plan-change emitter is ONE observer on the database client, so no write path can be missed:
 * (1) the client extension reports every write to the observer, (2) the API installs the observer
 * at startup, (3) nothing writes plan / subscription state around the client (raw SQL).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { guardedOperation, setModelWriteObserver } from '../../packages/database/src/tenant-guard';
import { storeScope } from '../../packages/database/src/tenant-scope';

const S = '11111111-1111-4111-8111-111111111111';
const run = (model: string, operation: string, args: unknown, result: unknown) =>
  storeScope.run({ storeId: S }, () =>
    guardedOperation({ model, operation, args, query: async () => result })
  );

afterEach(() => setModelWriteObserver(undefined));

describe('the client extension reports writes', () => {
  it('tells the observer about a write AFTER it succeeded, with the result', async () => {
    const seen = vi.fn();
    setModelWriteObserver(seen);
    const args = { where: { storeId: S }, data: { status: 'past_due' } };
    const out = await run('StoreSubscription', 'update', args, { storeId: S });
    expect(out).toEqual({ storeId: S });
    expect(seen).toHaveBeenCalledWith({
      model: 'StoreSubscription',
      operation: 'update',
      args,
      result: { storeId: S },
    });
  });

  it('does not report reads, and a failed write is not reported', async () => {
    const seen = vi.fn();
    setModelWriteObserver(seen);
    await run('StoreSubscription', 'findUnique', { where: { storeId: S } }, null);
    expect(seen).not.toHaveBeenCalled();
    await expect(
      storeScope.run({ storeId: S }, () =>
        guardedOperation({
          model: 'StoreSubscription',
          operation: 'update',
          args: { where: { storeId: S }, data: { status: 'active' } },
          query: async () => {
            throw new Error('db down');
          },
        })
      )
    ).rejects.toThrow('db down');
    expect(seen).not.toHaveBeenCalled();
  });

  it('a throwing observer never breaks a write that already succeeded', async () => {
    setModelWriteObserver(() => {
      throw new Error('observer bug');
    });
    await expect(
      run(
        'StoreSubscription',
        'update',
        { where: { storeId: S }, data: { status: 'active' } },
        { storeId: S }
      )
    ).resolves.toEqual({ storeId: S });
  });
});

const SRC = path.resolve(__dirname, '../../apps/api/src');
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n !== '__tests__') walk(p, out);
    } else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('wiring', () => {
  it('app.ts installs the observer at startup (Node shell and Worker both import it)', () => {
    expect(readFileSync(path.join(SRC, 'app.ts'), 'utf8')).toMatch(/installWaWriteObservers\(\);/);
  });

  it('no code writes catalog tables with raw SQL (it would bypass the catalog observer)', () => {
    // Raw writers exist (stock upserts, the gold repricer): each must tell Ebda Chat itself
    // (`notifyCatalogChanged`) or carry the waiver `wa-catalog: not-catalog-data`.
    const writers = walk(SRC).filter(f =>
      /(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?(products|product_variants|warehouse_stock)"?/.test(
        readFileSync(f, 'utf8')
      )
    );
    expect(writers.length).toBeGreaterThan(0); // the scan sees them
    const unhandled = writers.filter(f => {
      const t = readFileSync(f, 'utf8');
      return !/notifyCatalogChanged\(/.test(t) && !/wa-catalog: not-catalog-data/.test(t);
    });
    expect(unhandled.map(f => path.relative(SRC, f))).toEqual([]);
  });

  it('no code writes subscription / plan state with raw SQL (it would bypass the observer)', () => {
    // Waivers: `wa-plan: new-store-not-linked` (lib/store-create-do.ts: the INITIAL subscription row of a store created a moment ago
    // on D1, no WhatsApp link to tell; the `wa-plan-sync` cron reconciles every linked store) and `wa-plan: observer notified`
    // (a raw D1 writer, services/platform/billing-d1.ts, tells the observer itself via notifyModelWrite).
    const raw = walk(SRC).filter(f => {
      const t = readFileSync(f, 'utf8');
      if (/wa-plan: new-store-not-linked/.test(t)) return false;
      // cf/erasure/platform-subject.ts: PDPL erasure of a deleted store clears the card reference only; plan, status and period are untouched
      if (/wa-plan: not-plan-state/.test(t)) return false;
      if (/wa-plan: observer notified/.test(t) && /notifyModelWrite\(/.test(t)) return false;
      return (
        /(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?(store_subscriptions|store_whatsapp_consents)"?/i.test(
          t
        ) || /UPDATE\s+"?stores"?\s+SET\s+"?plan"?\b/i.test(t)
      );
    });
    expect(raw.map(f => path.relative(SRC, f))).toEqual([]);
  });
});
