/**
 * Audit M-169: every marketing page's meta description fits a search snippet: 100-160 characters (Arabic too: the thin
 * ones were 75-114, the English ones 177-200 and cut off in the SERP). Both locales, every page.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const APP = path.resolve(__dirname, '../../apps/marketing/src/app');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(f => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const pages = walk(APP).filter(f => /[\\/]page\.tsx$/.test(f) && !f.includes('_not-found'));

describe('marketing meta descriptions are 100-160 characters', () => {
  for (const file of pages) {
    const rel = path.relative(APP, file);
    it(rel, async () => {
      const mod = await import(file);
      const meta =
        mod.metadata ?? (await import(path.join(path.dirname(file), 'layout.tsx'))).metadata;
      const d = String(meta.description);
      expect(d.length, `${rel}: ${d}`).toBeGreaterThanOrEqual(100);
      expect(d.length, `${rel}: ${d}`).toBeLessThanOrEqual(160);
    });
  }
});
