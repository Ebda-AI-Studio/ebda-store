/**
 * Regression test for the bulk-import truncation bug: the global input
 * sanitizer truncated EVERY request string to 10k chars, silently cutting a
 * large `csvData` / `xlsxBase64` upload to ~21 rows. Large-content fields must
 * be exempt from the length cap while still getting control-char stripping.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeInput } from '../../apps/api/src/middleware/security';

function run(body: Record<string, unknown>) {
  const req = { body, query: {} } as any;
  let called = false;
  sanitizeInput(req, {} as any, () => {
    called = true;
  });
  expect(called).toBe(true);
  return req.body as Record<string, string>;
}

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);

describe('sanitizeInput large-content exemption', () => {
  const big = 'a,b,c\n'.repeat(5000); // ~30k chars, well over the 10k cap

  it('does NOT truncate csvData', () => {
    const out = run({ csvData: big });
    expect(out.csvData.length).toBeGreaterThan(10_000);
  });

  it('does NOT truncate xlsxBase64', () => {
    const out = run({ xlsxBase64: 'Z'.repeat(30_000) });
    expect(out.xlsxBase64.length).toBe(30_000);
  });

  it('STILL truncates ordinary fields to 10k', () => {
    const out = run({ description: 'x'.repeat(30_000) });
    expect(out.description.length).toBe(10_000);
  });

  it('still strips NUL/control chars from csvData but keeps the newline record boundary', () => {
    const dirty = `name,sku${NUL}${BEL}\nFoo,BAR`;
    const out = run({ csvData: dirty });
    expect(out.csvData).not.toContain(NUL); // NUL would truncate a Postgres TEXT column
    expect(out.csvData).not.toContain(BEL);
    expect(out.csvData).toContain('\n'); // CSV record boundary preserved
    expect(out.csvData).toContain('name,sku');
    expect(out.csvData).toContain('Foo,BAR');
  });
});

describe('sanitizeInput keeps array shapes (B0 Task 9)', () => {
  it('an array of arrays stays an array of arrays, cells still cleaned', () => {
    const out = run({
      rows: [
        ['S', ` 52${NUL} `],
        ['M', '54'],
      ],
      deep: [[['x']]],
      mixed: [{ a: [' b '] }, ['c']],
    }) as unknown as Record<string, unknown>;
    expect(out.rows).toEqual([
      ['S', '52'],
      ['M', '54'],
    ]);
    expect(out.deep).toEqual([[['x']]]);
    expect(out.mixed).toEqual([{ a: ['b'] }, ['c']]);
  });
});
