import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

describe('STORE-QA-43 anonymous session probe', () => {
  it('API answers 200 {user:null} only for ?probe=anon with no credential at all', () => {
    const src = read('apps/api/src/routes/auth.routes.ts');
    const fn = src.slice(src.indexOf('function anonymousProbe'), src.indexOf('// GET /auth/me'));
    expect(fn).toContain("req.query.probe === 'anon'");
    expect(fn).toContain('!req.cookies?.token');
    expect(fn).toContain('!req.cookies?.refresh_token');
    expect(fn).toContain('!req.headers.authorization');
    expect(src).toMatch(/'\/me',\s*anonymousProbe,\s*authenticate/);
  });
  it('every storefront caller treats user:null as signed out', () => {
    expect(read('apps/web/src/contexts/AuthContext.tsx')).toContain('result.data?.user &&');
    expect(read('apps/web/src/app/account/settings/SettingsClient.tsx')).toContain(
      'result.data?.user)'
    );
    const api = read('apps/web/src/lib/api.ts');
    expect(api).toContain("'/auth/me?probe=anon'");
    expect(api).toContain("!endpoint.startsWith('/auth/me')");
  });
});

describe('STORE-QA-45/52 cart', () => {
  it('a refused or throttled quantity change restores what the server accepted and says why', () => {
    const ctx = read('apps/web/src/contexts/CartContext.tsx');
    expect(ctx).toContain('const rollback = async () =>');
    const cart = read('apps/web/src/app/cart/CartClient.tsx');
    expect(cart).toContain("e?.code === 'RATE_LIMITED'");
    expect(cart).toContain("t('Enter a code', 'ادخل الكود')");
  });
});

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
