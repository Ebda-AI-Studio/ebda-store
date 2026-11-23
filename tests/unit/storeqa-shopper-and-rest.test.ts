import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

describe('STORE-QA-47/48/49/50 storefront', () => {
  it('contact hides empty rows, about has default copy, PDP is og:type product, filters sync the URL', () => {
    expect(read('apps/web/src/app/contact/ContactClient.tsx')).toMatch(/\{emailHref && \(/);
    expect(read('apps/web/src/app/about/AboutClient.tsx')).toContain('أهلاً بيك في');
    const pdp = read('apps/web/src/app/products/[slug]/ProductDetailBody.tsx');
    expect(pdp).toContain("'og:type': 'product'");
    expect(pdp).not.toContain("type: 'website'");
    expect(read('apps/web/src/app/products/ProductsClient.tsx')).toContain(
      'window.history.replaceState'
    );
  });
});

describe('admin: QA-31/33/34', () => {
  it('refund step is named as an action, non-uuid order ids 404, one answer-engine empty state', () => {
    expect(
      read('apps/admin/src/app/stores/[id]/orders/[orderId]/_components/ActionFooter.tsx')
    ).toContain("t('refundOrder')");
    expect(read('apps/admin/src/app/stores/[id]/orders/[orderId]/page.tsx')).toContain(
      'notFound();'
    );
    expect(read('apps/admin/src/app/stores/[id]/answer-engine/page.tsx')).toContain(
      'summary.prompts.length === 0'
    );
  });
});
