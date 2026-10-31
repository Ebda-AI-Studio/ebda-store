// Ruling CF-R6A-4: instapay_order_receipts (a DO runtime table) is copied from the platform instapay_receipts rows of
// kind 'order' at cutover, with count + checksum on both sides, so a store with orders awaiting payment confirmation can
// be flipped. These tests pin the mapping against the DO DDL and the Prisma model, and run import -> verify on a DO shape.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TableDigest } from '../src/canon.mjs';
import { PG_SOURCED_DO_TABLES, pgSourcedTables } from '../src/coverage.mjs';
import { handleStoreAdmin } from '../src/store-admin.mjs';
import { scopeWhere, tableQuery } from '../../../scripts/cf/lib/plan.mjs';
import { INSTAPAY_RECEIPT_DDL } from '../../repo/src/do/instapay-receipts';
import { ndjson, storeDo } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const meta = JSON.parse(
  fs.readFileSync(path.join(here, '../../cf-schema/generated/prisma-meta.json'), 'utf8')
);
const [t] = pgSourcedTables();
const cols = t.columns.map((c: { col: string }) => c.col);

function doWithReceipts() {
  const ctx = storeDo();
  for (const s of INSTAPAY_RECEIPT_DDL) ctx.db.exec(s);
  return ctx;
}
const post = (ctx: ReturnType<typeof storeDo>, p: string, body: string) =>
  handleStoreAdmin(
    new Request(`https://do.test/cutover/stores/s1/${p}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    }),
    ctx
  );

describe('instapay_order_receipts is sourced from Postgres at cutover', () => {
  it('its columns are exactly the DO table columns', () => {
    const ctx = doWithReceipts();
    const have = (
      ctx.db.prepare("SELECT name FROM pragma_table_info('instapay_order_receipts')").all() as {
        name: string;
      }[]
    ).map(r => r.name);
    expect([...cols].sort()).toEqual([...have].sort());
  });

  it('every column of the Prisma model is carried or deliberately ignored', () => {
    const model =
      meta.models[
        PG_SOURCED_DO_TABLES.instapay_order_receipts.origin === 'instapay_receipts'
          ? 'InstapayReceipt'
          : ''
      ];
    const pg: string[] = Object.values(
      model.fields as Record<string, { kind: string; column: string }>
    )
      .filter(f => f.kind === 'scalar')
      .map(f => f.column);
    const rule = PG_SOURCED_DO_TABLES.instapay_order_receipts;
    const missing = pg.filter(c => !cols.includes(c) && !rule.ignored.includes(c));
    expect(missing).toEqual([]);
    for (const c of cols) expect(pg, c).toContain(c);
  });

  it('the source query is store-scoped and takes only order receipts', () => {
    const sql = tableQuery(t, [], 'store');
    expect(sql).toContain('t.store_id = $1');
    expect(sql).toContain("t.kind = 'order'");
    expect(scopeWhere(t, [])).toBe("t.store_id = $1 AND t.kind = 'order'");
  });

  it('imports, replays idempotently and verifies with count + checksum', async () => {
    const ctx = doWithReceipts();
    const row = (id: string, ref: string | null, status: string) =>
      cols.map((c: string) => {
        const v: Record<string, unknown> = {
          id,
          store_id: 's1',
          order_id: `o-${id}`,
          storage_key: `k/${id}`,
          mime_type: 'image/png',
          size_bytes: 10,
          sha256: `sha-${id}`,
          status,
          extraction_status: 'done',
          extracted: '{"a": 1}',
          confidence: 0.5,
          amount_minor: 12_300,
          reference: ref,
          reference_key: ref,
          submitted_at: 1_700_000_000_000,
          flags: '["AMOUNT_MISMATCH"]',
          created_at: 1_700_000_000_000,
        };
        return v[c] ?? null;
      });
    const rows = [row('r1', '111', 'submitted'), row('r2', null, 'rejected')];
    const head = { batch: 'cut-test-1', table: t.name, page: 0, columns: cols, pk: ['id'] };
    expect(await (await post(ctx, '__import', ndjson(head, rows))).json()).toMatchObject({
      ok: true,
      rows: 2,
    });
    expect(await (await post(ctx, '__import', ndjson(head, rows))).json()).toMatchObject({
      skipped: true,
    });
    const d = new TableDigest();
    for (const r of rows) await d.add(cols, r, ['id']);
    const want = await d.finish();
    const v = await (
      await post(
        ctx,
        '__verify',
        JSON.stringify({ tables: [{ table: t.name, columns: cols, pk: ['id'] }] })
      )
    ).json();
    expect(v.tables[t.name]).toMatchObject({ count: 2, digest: want.digest });
  });
});
