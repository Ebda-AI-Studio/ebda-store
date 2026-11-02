import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const api = join(__dirname, '../../apps/api/src');
const read = (p: string) => readFileSync(join(api, p), 'utf8');

describe('catalogue import never publishes on its own', () => {
  it('the draft-creating function and the extraction path write no active status', () => {
    for (const f of [
      'lib/inngest/functions/catalog-import-create-drafts.ts',
      'lib/inngest/functions/catalog-import-run.ts',
      'lib/catalogue/process-file.ts',
    ]) {
      expect(read(f), f).not.toMatch(/['"]active['"]/);
    }
  });

  it('exactly one site in the service writes an active status: publishItems', () => {
    const src = read('services/catalog-import.service.ts')
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const hits = [...src.matchAll(/'active'/g)];
    expect(hits).toHaveLength(1);
    const publish = src.slice(src.indexOf('export async function publishItems'));
    expect(publish).toContain("'active'");
  });

  it('no job function imports publishItems', () => {
    const dir = join(api, 'lib/inngest/functions');
    for (const f of readdirSync(dir).filter(n => n.startsWith('catalog-import'))) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain('publishItems');
    }
  });

  it('every Gemini call uses the alias, never a versioned model name', () => {
    for (const f of ['lib/catalogue/gemini-vision-extractor.ts', 'lib/catalogue/prompt.ts']) {
      expect(read(f), f).not.toMatch(/gemini-\d/);
    }
    expect(read('lib/catalogue/gemini-vision-extractor.ts')).toContain('gemini-flash-lite-latest');
  });

  it('the upload route stays behind auth, admin role and store access', () => {
    const src = read('routes/catalog-import.routes.ts');
    expect(src).toContain("authorize('store_admin', 'super_admin')");
    expect(src).toContain('requireStoreAccess');
    expect(src).toContain('catalogImportStoreLimiter');
  });
});
