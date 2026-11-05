/**
 * `@ebda/shared/brand` resolves to RAW TypeScript (`./src/brand/index.ts`, no dist condition) and is imported by the API
 * (`contact-enquiry-public.routes`) and by the site-kit build under plain Node, with no bundler: a relative import inside it
 * cannot resolve without an extension. The API integration job died with ERR_MODULE_NOT_FOUND on `export * from './billing-vat'`
 * there. Anything else belongs in `src/index.ts` (compiled by tsc).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../packages/shared');

describe('@ebda/shared/brand (raw TypeScript entry)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, Record<string, string>>;
  };
  it('has no dist condition (so Node really loads the source file)', () => {
    expect(pkg.exports['./brand'].default).toBe('./src/brand/index.ts');
    expect(pkg.exports['./brand'].import).toBeUndefined();
    expect(pkg.exports['./brand'].require).toBeUndefined();
  });
  it('imports no sibling module at all', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/brand/index.ts'), 'utf8');
    const rel = [...src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map(
      m => m[1]
    );
    expect(rel).toEqual([]);
  });
  it('the billing VAT vocabulary is still exported from the package root', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
    expect(idx).toContain("export * from './brand/billing-vat'");
  });
});
