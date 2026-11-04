/**
 * T1 route hardening, wiring table. These routers need a database to run, so each row reads the route's own registration chain
 * (everything between `router.<method>(` and the handler) and asserts the gate is in it. The gates themselves are exercised
 * elsewhere (rejectImpersonated: impersonation-guards.test.ts; requireFeature / requireMfaEnrolled / authorize: their own suites).
 * A row that names a route that no longer exists FAILS (no silent empty pass).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../apps/api/src/routes');

function chainOf(file: string, method: string, routePath: string): string {
  const text = readFileSync(path.join(SRC, file), 'utf8');
  const start = text.indexOf(`router.${method}(\n  '${routePath}',`);
  if (start < 0) throw new Error(`route not found: ${method} ${routePath} in ${file}`);
  const end = text.indexOf('async (', start);
  return text.slice(start, end);
}

const ROWS: Array<[string, string, string, string[], string]> = [
  // S-4: finance data is owner + MFA + accounting.basic, like /finance/*
  ...['/performance', '/cashflow', '/stock-snapshot'].map(
    p =>
      [
        'analytics.routes.ts',
        'get',
        p,
        [
          "authorize('store_admin', 'super_admin')",
          'requireMfaEnrolled',
          "requireFeature('accounting.basic')",
        ],
        'S-4',
      ] as [string, string, string, string[], string]
  ),
  // S-9: seo feature on the writes
  ...[
    ['put', '/:id/seo'],
    ['post', '/:id/faqs'],
    ['put', '/:id/faqs/:faqId'],
    ['post', '/:id/howtos'],
    ['put', '/:id/howtos/:howtoId'],
  ].map(
    ([m, p]) =>
      ['store.routes.ts', m, p, ["requireFeature('seo')"], 'S-9'] as [
        string,
        string,
        string,
        string[],
        string,
      ]
  ),
  [
    'slug-redirects.routes.ts',
    'delete',
    '/:storeId/slug-redirects/:id',
    ["requireFeature('seo')"],
    'S-9',
  ],
  // S-11: super_admin must have MFA on money / credential / staff / push / billing
  ['payment.routes.ts', 'post', '/refund', ['requireMfaEnrolled'], 'S-11'],
  ['staff.routes.ts', 'post', '/', ['requireMfaEnrolled'], 'S-11'],
  [
    'payment-settings.routes.ts',
    'put',
    '/store/:storeId/:provider/credentials',
    ['requireMfaEnrolled'],
    'S-11',
  ],
  ['payment-settings.routes.ts', 'post', '/store/:storeId', ['requireMfaEnrolled'], 'S-11'],
  // S-13: retry
  ['payment.routes.ts', 'post', '/retry/:paymentId', ['rejectImpersonated'], 'S-13'],
  // S-18: merchants own the font upload, super_admin-only permission is gone
  ['upload.routes.ts', 'post', '/font', ["requirePermission('store:settings')"], 'S-18'],
  // F-8: same gate as the /codes page
  ...['/:storeId/qr/settings', '/:storeId/qr/stats'].map(
    p =>
      ['qr.routes.ts', 'get', p, ["requireFeature('inventory.barcode')"], 'F-8'] as [
        string,
        string,
        string,
        string[],
        string,
      ]
  ),
  ['qr.routes.ts', 'put', '/:storeId/qr/settings', ["requireFeature('inventory.barcode')"], 'F-8'],
];

describe('T1 gates are in the route chain', () => {
  it('the table is not empty', () => expect(ROWS.length).toBeGreaterThan(15));

  it.each(ROWS)('%s %s %s', (file, method, routePath, needles, id) => {
    const chain = chainOf(file, method, routePath);
    for (const n of needles) expect(chain, `${id}: ${n}`).toContain(n);
  });

  it('S-18: /uploads/font no longer needs the super_admin-only settings:write', () => {
    expect(chainOf('upload.routes.ts', 'post', '/font')).not.toContain("'settings:write'");
  });

  it('S-11 (push + billing): the shared chains carry requireMfaEnrolled', () => {
    expect(readFileSync(path.join(SRC, 'onesignal.routes.ts'), 'utf8')).toMatch(
      /adminStoreMiddleware = \[\s*authenticate,\s*requireMfaEnrolled/
    );
    expect(readFileSync(path.join(SRC, 'billing.routes.ts'), 'utf8')).toMatch(
      /const guard = \[\s*authenticate,\s*requireMfaEnrolled/
    );
  });
});
