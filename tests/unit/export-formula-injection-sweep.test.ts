/**
 * Spreadsheet-export formula-injection SWEEP (S2, 2026-10-14).
 *
 * `csvField` / `neutralizeFormula` (packages/shared/src/csv-utils.ts) are the
 * one guard; csv-formula-guard.test.ts proves the guard itself. This proves
 * every EMITTER uses it, so a new exporter that joins raw cells fails here
 * instead of shipping a `=HYPERLINK(...)` from a customer's name.
 *
 * Audited 2026-10-14: 5 CSV emitters (admin orders export, newsletter, product
 * export + template, finance reports client) and every ExcelJS `addRow`.
 * Static source scan; no DB.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const apiSrc = path.resolve(__dirname, '../../apps/api/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === '__tests__' || e === 'node_modules') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}
const files = walk(apiSrc);
const rel = (p: string) => path.relative(apiSrc, p);

describe('every ExcelJS addRow neutralises its string cells', () => {
  // A call is safe when it is wrapped, or when it carries only text the server
  // itself wrote: spacers, fixed section/column titles, the numeric-only
  // "export truncated" notice, and the static canonical-areas template.
  const SAFE_PREFIXES = [
    'neutralizeRow', // neutralizeRowObject / neutralizeRowArray
    'safeRows', // streamXlsxResponse: opts.rows.map(neutralizeRowObject)
    '[]',
    "['TOPPRODUCTS']",
    "['SPENDPERCUSTOMER']",
    "['Product','TotalQty'",
    "['Customer','Email'",
    '{storeName:`NOTE:exporttruncated',
    '[ordersTruncated?`NOTE:exporttruncated',
    '{governorate:gov.en', // shipping area-rate template of canonical areas
  ];
  const callRe = /\.addRows?\(([\s\S]{0,160})/g;
  for (const f of files) {
    const src = readFileSync(f, 'utf-8')
      .split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)) // doc comments name addRow too
      .join('\n');
    if (!/\.addRows?\(/.test(src)) continue;
    it(`${rel(f)}`, () => {
      const offenders: string[] = [];
      for (const m of src.matchAll(callRe)) {
        const arg = m[1].replace(/\s+/g, '');
        if (!SAFE_PREFIXES.some(pfx => arg.startsWith(pfx))) offenders.push(arg.slice(0, 80));
      }
      expect(offenders, `unguarded addRow in ${rel(f)}`).toEqual([]);
    });
  }

  it('found the exporters this sweep is meant to cover', () => {
    const covered = files.filter(f => /\.addRows?\(/.test(readFileSync(f, 'utf-8'))).map(rel);
    expect(covered).toEqual(
      expect.arrayContaining([
        'lib/exports/xlsx.ts',
        'routes/customers.routes.ts',
        'routes/order.routes.ts',
        'routes/shipping.routes.ts',
      ])
    );
  });
});

describe('every text/csv emitter routes cells through csvField', () => {
  const emitters = files.filter(f =>
    /setHeader\(\s*'Content-Type',\s*'text\/csv/.test(readFileSync(f, 'utf-8'))
  );
  it('found the CSV routes', () => {
    expect(emitters.map(rel)).toEqual(
      expect.arrayContaining([
        'routes/admin.routes.ts',
        'routes/newsletter.routes.ts',
        'routes/bulk.routes.ts',
      ])
    );
  });
  for (const f of emitters) {
    it(`${rel(f)} imports csvField from @ebda/shared (directly or via the bulk service)`, () => {
      const src = readFileSync(f, 'utf-8');
      const viaService = rel(f) === 'routes/bulk.routes.ts' && /BulkService\./.test(src);
      expect(/csvField/.test(src) || viaService).toBe(true);
    });
  }

  it('product export builds user-text columns with csvField', () => {
    const src = readFileSync(path.join(apiSrc, 'services/bulk.service.ts'), 'utf-8');
    for (const col of ['product.name', 'product.description', 'product.sku', 'variant.sku']) {
      expect(src).toContain(`csvField(${col}`);
    }
  });
});
