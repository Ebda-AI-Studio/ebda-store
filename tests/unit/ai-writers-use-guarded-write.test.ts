/**
 * Issue #620 / Ruling NEVER-OVERWRITE-1: every job that writes AI output to product fields goes through the one guarded,
 * fill-only write (writeAiFieldsGuarded, via writeBulkProductFields). A direct `product.update` in an AI job reads the row,
 * waits on the AI, then blind-writes: a merchant edit made meanwhile is lost. This fails on the old bulk-ai-* code.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeBulkProductFields } from '@api/services/ai-autofill.service';

const DIR = join(__dirname, '../../apps/api/src/lib/inngest/functions');
const aiJobs = readdirSync(DIR).filter(
  f => /^(bulk-ai-|ai-autofill-).*\.ts$/.test(f) && !f.includes('.test.')
);

describe('AI jobs write product fields only through the guarded fill-only layer', () => {
  it('finds the AI jobs', () => expect(aiJobs.length).toBeGreaterThan(10));
  for (const f of aiJobs) {
    it(`${f}: no direct product.update / updateMany / upsert`, () => {
      const src = readFileSync(join(DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src).not.toMatch(/\.product\.(update|updateMany|upsert)\s*\(/);
    });
  }
  for (const f of [
    'bulk-ai-seo.ts',
    'bulk-ai-translate.ts',
    'bulk-ai-excerpt.ts',
    'bulk-ai-aeo.ts',
    'bulk-ai-geo.ts',
  ]) {
    it(`${f}: uses writeBulkProductFields`, () =>
      expect(readFileSync(join(DIR, f), 'utf8')).toContain('writeBulkProductFields('));
  }
});

describe('writeBulkProductFields', () => {
  it('without overwrite, a field already holding text is never a candidate (nothing is written)', async () => {
    expect(
      await writeBulkProductFields(
        's',
        'p',
        { metaTitle: 'merchant title' },
        { metaTitle: 'AI title', metaTitleAr: '  ' }
      )
    ).toEqual([]);
  });
});
