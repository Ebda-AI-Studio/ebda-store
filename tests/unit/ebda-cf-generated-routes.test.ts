import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand';

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
      execFileSync('bash', [join(root, 'scripts/cf-setup-local.sh')], {
        env: { ...process.env, CF_SETUP_SKIP_DEPS: '1', OPENNEXT_CACHE: cache },
      });
      for (const [app, host] of Object.entries({
        web: BRAND.domains.marketing,
        admin: BRAND.domains.admin,
        orders: BRAND.domains.orders,
      })) {
        const config = JSON.parse(readFileSync(join(root, 'apps', app, 'wrangler.jsonc'), 'utf8'));
        expect(config.routes).toContainEqual({ pattern: host, custom_domain: true });
        expect(
          config.routes.every(
            (r: { pattern: string; zone_name?: string }) =>
              (!r.zone_name || r.zone_name === BRAND.domains.marketing) &&
              !/force-ai|pecannbee/.test(r.pattern)
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
