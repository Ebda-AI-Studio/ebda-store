/** The ORM-decision evidence copies (spikes/store-do/src/{repo,schema}.ts) must equal the shipped StoreDO sources. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('store-do spike sources do not drift from the shipped copy', () => {
  for (const f of ['repo.ts', 'schema.ts']) {
    it(`${f} is identical`, () => {
      expect(readFileSync(`spikes/store-do/src/${f}`, 'utf8')).toBe(
        readFileSync(`apps/api/src/cf/store-do/${f}`, 'utf8')
      );
    });
  }
});
