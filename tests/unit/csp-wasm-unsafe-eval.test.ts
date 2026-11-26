/**
 * QA-109: the product 3D viewer decodes meshopt (WebAssembly). Both hosts must allow wasm compile and still never allow eval().
 */
import { describe, it, expect } from 'vitest';
import { buildAdminCsp } from '../../apps/admin/src/lib/csp';
import { buildStorefrontCsp } from '../../apps/web/src/lib/csp';

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';
const scriptSrc = (c: string) => (c.match(/(?:^|; )script-src [^;]*/) ?? [''])[0].split(/\s+/);

describe("'wasm-unsafe-eval' for the 3D viewer, never 'unsafe-eval'", () => {
  it.each(['/', '/stores/abc/products/p1/edit', '/stores/abc/builder'])('admin %s', p => {
    const c = buildAdminCsp({ nonce: NONCE, pathname: p, apiOrigin: 'https://api.ebda.app' });
    expect(scriptSrc(c)).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc(c)).not.toContain("'unsafe-eval'");
    expect(scriptSrc(c)).not.toContain("'unsafe-inline'");
    expect(scriptSrc(c)).toContain("'strict-dynamic'");
    expect(c).toContain("worker-src 'self' blob:");
  });

  it('storefront', () => {
    const c = buildStorefrontCsp(NONCE);
    expect(scriptSrc(c)).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc(c)).not.toContain("'unsafe-eval'");
    expect(c).toContain('https://media.ebda.app');
  });

  it('the admin local .glb preview can fetch its blob: URL', () => {
    const c = buildAdminCsp({ nonce: NONCE, pathname: '/', apiOrigin: 'https://api.ebda.app' });
    expect((c.match(/connect-src [^;]*/) ?? [''])[0].split(/\s+/)).toContain('blob:');
  });
});
