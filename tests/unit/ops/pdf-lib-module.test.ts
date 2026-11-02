import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Ruling BUNDLE-BUDGET-7: pdf-lib is a separate Worker module built by scripts/ci/gen-pdf-lib-module.mjs.
const ROOT = join(__dirname, '../../..');

describe('the pdf-lib Worker module', () => {
  it('was built from the installed @cantoo/pdf-lib version', () => {
    const v = JSON.parse(
      readFileSync(join(ROOT, 'node_modules/@cantoo/pdf-lib/package.json'), 'utf8')
    ).version;
    const head = readFileSync(join(ROOT, 'apps/api/src/cf/modules/pdf-lib.mjs'), 'utf8').slice(
      0,
      80
    );
    expect(head).toContain(`@cantoo/pdf-lib@${v} `);
  });

  it('loads and reads a PDF it wrote', async () => {
    const spec = '../../../apps/api/src/cf/modules/pdf-lib.mjs';
    const { PDFDocument } = (await import(/* @vite-ignore */ spec)).default;
    const d = await PDFDocument.create({ updateMetadata: false });
    d.addPage();
    const back = await PDFDocument.load(await d.save({ useObjectStreams: false }));
    expect(back.getPageCount()).toBe(1);
  });

  it('is not bundled into the main script: sniff.ts imports it through a variable specifier', () => {
    const src = readFileSync(join(ROOT, 'apps/api/src/lib/catalogue/sniff.ts'), 'utf8');
    expect(src).not.toMatch(/import \{ PDFDocument \} from '@cantoo\/pdf-lib'/);
    expect(src).toContain('import type { PDFDocument');
    expect(src).toContain('await import(/* @vite-ignore */ spec)');
  });
});
