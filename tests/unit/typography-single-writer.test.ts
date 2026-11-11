import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Ruling TYPO-WRITER-1: builder publish is the only writer of stores.typography.
describe('typography route is read-only (single writer)', () => {
  const src = readFileSync(
    join(__dirname, '../../apps/api/src/routes/typography.routes.ts'),
    'utf8'
  );
  it('registers no write verb', () => {
    expect(src).not.toMatch(/router\.(put|post|patch|delete)\(/);
  });
  it('does not write the store row', () => {
    expect(src).not.toMatch(/storeUpdate|\.update\(|typographySchema/);
  });
  it('still serves GET for the builder editor', () => {
    expect(src).toMatch(/router\.get\(/);
  });
});
