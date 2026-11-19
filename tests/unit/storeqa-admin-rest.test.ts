import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = (p: string) => readFileSync(p, 'utf8');
const S = 'apps/admin/src/app/stores/[id]/';

describe('STORE-QA-8/36 product names follow the page language', () => {
  it('low-stock API carries nameAr on both backends and the admin lists use it', () => {
    expect(read('packages/repo/src/do/analytics-reads.ts')).toContain('p.name_ar AS nameAr');
    expect(read('apps/api/src/services/analytics.service.ts')).toContain('p.name_ar');
    expect(read(S + 'analytics/_components/LowStockAlertsCard.tsx')).toContain('nameOf(product)');
    expect(read(S + 'stock/inventory/page.tsx')).toContain('(isAr && p.nameAr) || p.name');
  });
});
describe('STORE-QA-12/35/38/39', () => {
  it('empty columns hide, AI usage maps features and hides the model, barcode previews stay in their tile, one rationale language', () => {
    const pt = read(S + 'products/_components/ProductsTable.tsx');
    expect(pt).toContain('hasSku');
    expect(pt).toContain('hasCost');
    const ai = read(S + 'ai-usage/page.tsx');
    expect(ai).toContain('featureNames.');
    expect(ai).not.toContain("t('table.model')");
    expect(read('apps/admin/src/components/ReceiptBarcodePicker.tsx')).toContain(
      '[&>svg]:max-w-full'
    );
    const ro = read(S + 'stock/reorder/page.tsx');
    expect(ro).toContain('(isAr && item.reasoningAr) || item.reasoningEn');
    expect(ro).not.toContain('{item.reasoningEn}</p>\n      {item.reasoningAr');
  });
});
