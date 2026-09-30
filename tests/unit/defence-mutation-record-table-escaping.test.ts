/**
 * #1232: the mutation-record generator escaped `|` (breaks a markdown table
 * cell) but not newlines. Four spec entries have multi-line `find` strings,
 * so a literal newline landed inside a table row — the committed record
 * showed the money-refund-transition-guard row split across two lines and
 * the tenant-product-faq-ownership / tenant-store-resolver-domain-notfound
 * rows split across several, breaking the table so those defences' verdicts
 * rendered OUTSIDE it.
 *
 * The generator's top level runs the real mutation suite as a side effect of
 * being imported (no isMain guard — deliberately, given its signal-handling
 * shape), so this asserts the escaping structurally rather than importing it,
 * and verifies the actual generated artifact has no malformed row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

describe('#1232: defence-mutation-record cell escaping', () => {
  it('escapes both `|` and newlines before truncating a cell', () => {
    const src = readFileSync(path.join(ROOT, 'scripts/defence-mutation-record.mjs'), 'utf8');
    expect(src, 'no newline escaping found — the multi-line find/replace bug is back').toMatch(
      /\.replace\(\/\\r\?\\n\/g,\s*'\\\\n'\)/
    );
    expect(src).toMatch(/\.replace\(\/\\\|\/g,\s*'\\\\\|'\)/);
  });

  it('the committed record has no table row broken by an unescaped newline', () => {
    const record = readFileSync(
      path.join(ROOT, 'docs/security/defence-mutation-record.md'),
      'utf8'
    );
    const tableLines = record.split('\n').filter(l => l.startsWith('|'));
    expect(tableLines.length, 'no table rows found — the record shape changed').toBeGreaterThan(10);
    // A row with a real "Defence | Source | Mutation | Verdict" shape has at
    // least 5 pipe characters (4 columns + the leading one); a row broken by
    // a literal newline has far fewer on the fragment that follows.
    const malformed = tableLines.filter(l => (l.match(/\|/g) ?? []).length < 5);
    expect(malformed, `malformed row(s): ${malformed.join(' / ')}`).toEqual([]);
  });

  it('every unit-tier defence (the record’s default scope, per CI) has its own table row', () => {
    // CI regenerates with no --tier flag, which defaults to 'unit' — the
    // sole integration-tier defence is intentionally absent from the
    // committed record, not a hole this test should flag.
    const spec = JSON.parse(
      readFileSync(path.join(ROOT, 'docs/security/defence-mutations.json'), 'utf8')
    ) as { defences: Array<{ id: string; tier: string }> };
    const record = readFileSync(
      path.join(ROOT, 'docs/security/defence-mutation-record.md'),
      'utf8'
    );
    const missing = spec.defences
      .filter(d => d.tier === 'unit')
      .filter(
        d =>
          !new RegExp(`^\\| ${d.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<br>`, 'm').test(record)
      )
      .map(d => d.id);
    expect(
      missing,
      'unit-tier defence(s) present in the spec but missing their own table row in the record'
    ).toEqual([]);
  });
});
