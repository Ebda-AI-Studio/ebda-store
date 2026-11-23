import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { barcodeField } from '../product-payload';
import { ERROR_AR, ERROR_EN } from '../error-messages';

describe('barcodeField', () => {
  it('create: a typed barcode is sent, trimmed', () => {
    expect(barcodeField('  6223001234567 ', undefined, 'create')).toEqual({
      barcode: '6223001234567',
    });
  });
  it('create: empty is omitted so the API can auto-generate', () => {
    expect(barcodeField('   ', undefined, 'create')).toEqual({});
  });
  it('update: unchanged is omitted (never clobbers an auto-generated code)', () => {
    expect(barcodeField('6223001234567', '6223001234567', 'update')).toEqual({});
    expect(barcodeField('', null, 'update')).toEqual({});
  });
  it('update: emptied sends null to clear, changed sends the new code', () => {
    expect(barcodeField('', '6223001234567', 'update')).toEqual({ barcode: null });
    expect(barcodeField('4006381333931', '6223001234567', 'update')).toEqual({
      barcode: '4006381333931',
    });
  });
});

describe('barcode error copy', () => {
  it.each(['BARCODE_IN_USE', 'BARCODE_INVALID'])('%s has ar and en text', code => {
    expect(ERROR_AR[code]).toMatch(/[؀-ۿ]/);
    expect(ERROR_EN[code]).toBeTruthy();
  });
});

describe('the product forms expose the barcode (scan page needs it set from the UI)', () => {
  const root = resolve(__dirname, '../../app/stores/[id]/products');
  const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
  it.each([
    ['new/page.tsx', "t('fields.barcode')"],
    ['[productId]/edit/page.tsx', "tFields('barcode')"],
    ['[productId]/variants/_components/SimpleVariantsForm.tsx', "t('colBarcode')"],
  ])('%s renders a barcode input and sends it through barcodeField', (file, label) => {
    const src = read(file);
    expect(src).toContain(label);
    expect(src).toContain('barcodeField(');
  });
});
