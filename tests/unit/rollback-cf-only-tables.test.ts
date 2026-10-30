/** Opus I2 (Ruling CF-OPUS-2): a rollback never silently drops a Cloudflare-only table that holds a business fact. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain mjs
import {
  CF_ONLY_FACT_TABLES,
  isDiscardable,
  unreplayedLoss,
} from '../../scripts/cf/lib/rollback-coverage.mjs';

const diff = (n: number) => ({ added: Array(n).fill([]), changed: [], deleted: [] });

describe('rollback coverage of Cloudflare-only tables', () => {
  it.each(CF_ONLY_FACT_TABLES)(
    '%s with changes is lossy (refuses without --accept-data-loss)',
    (t: string) => {
      expect(isDiscardable(t)).toBe(false);
      expect(unreplayedLoss('shop', { [t]: diff(1) }, new Set())).toHaveLength(1);
    }
  );
  it('an InstaPay receipt filed after the flip blocks the rollback', () => {
    const l = unreplayedLoss('shop', { instapay_order_receipts: diff(2) }, new Set(['orders']));
    expect(l[0]).toContain('shop.instapay_order_receipts');
  });
  it('a replayed table, a discardable one and an unchanged one are not lossy', () => {
    expect(
      unreplayedLoss(
        's',
        { orders: diff(3), entity_index: diff(5), _money_ops: diff(1), payment_event_log: diff(0) },
        new Set(['orders'])
      )
    ).toEqual([]);
  });
  it('an unlisted, unknown table is lossy by default', () => {
    expect(unreplayedLoss('s', { brand_new_table: diff(1) }, new Set())).toHaveLength(1);
  });
  it('flip-backend feeds every store and D1 diff through it, and no longer only reports', () => {
    const src = readFileSync(`${__dirname}/../../scripts/cf/flip-backend.mjs`, 'utf8');
    expect(src).toContain("unreplayedLoss('D1'");
    expect(src).toContain('unreplayedLoss(s.slug');
    expect(src).not.toContain('not replayed');
  });
});
