import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand';
import { seedFetchContract } from '../helpers/fetch-contract-fixture';

describe('Ebda generated Cloudflare routes', () => {
  it.each(['false', 'true'])('uses Ebda routes after regeneration with cache=%s', cache => {
    const root = mkdtempSync(join(tmpdir(), 'ebda-cf-routes-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'packages/shared/dist/brand'), { recursive: true });
      writeFileSync(
        join(root, 'packages/shared/dist/brand/index.js'),
        `exports.BRAND = ${JSON.stringify(BRAND)};`
      );
      for (const file of ['cf-setup-local.sh', 'cf-routes.cjs'])
        cpSync(`scripts/${file}`, join(root, 'scripts', file));
      for (const app of ['web', 'admin', 'orders'])
        mkdirSync(join(root, 'apps', app), { recursive: true });
      seedFetchContract(root); // the web cache config bakes the data-contract hash (Ruling WEB-COLD-2)
      execFileSync('bash', [join(root, 'scripts/cf-setup-local.sh')], {
        env: { ...process.env, CF_SETUP_SKIP_DEPS: '1', OPENNEXT_CACHE: cache },
      });
      for (const [app, host] of Object.entries({
        web: BRAND.domains.marketing,
        admin: BRAND.domains.storeApp,
        orders: BRAND.domains.orders,
      })) {
        const config = JSON.parse(readFileSync(join(root, 'apps', app, 'wrangler.jsonc'), 'utf8'));
        if (app === 'web') {
          // Storefront: wildcard subdomains plus `*/*` for merchant custom domains (M-072). `*/*` is only safe because the apex
          // and every other hostname have explicit, more specific routes: tests/unit/cf-route-precedence.test.ts.
          expect(config.routes).toEqual([
            { pattern: `*${BRAND.domains.storeSuffix}/*`, zone_name: BRAND.domains.marketing },
            { pattern: '*/*', zone_name: BRAND.domains.marketing },
          ]);
        } else expect(config.routes).toContainEqual({ pattern: host, custom_domain: true });
        expect(
          config.routes.every(
            (r: { pattern: string; zone_name?: string }) =>
              (!r.zone_name || r.zone_name === BRAND.domains.marketing) &&
              !new RegExp('for' + 'ce-ai|demo-store').test(r.pattern)
          )
        ).toBe(true);
        if (app !== 'web')
          expect(config.routes).toContainEqual({
            pattern: `${host}/*`,
            zone_name: BRAND.domains.marketing,
          });
        if (app === 'web' && cache === 'true')
          expect(config.durable_objects.bindings).toHaveLength(2);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
