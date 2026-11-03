/**
 * Audit G-1 (2026-11-03): the OneSignal push SDK is storefront-only. In the admin it injected an
 * English opt-in card over the editor and intercepted clicks on its tabs. No admin source may
 * import or load it, no admin dependency may pull it, and the admin CSP must not allowlist its hosts.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildAdminCsp } from '../../apps/admin/src/lib/csp';

const ADMIN = join(__dirname, '../../apps/admin');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e === '.open-next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(e) && !/\.test\./.test(e)) out.push(p);
  }
  return out;
}

describe('OneSignal is not loaded in apps/admin', () => {
  it('no admin source imports react-onesignal, the CDN SDK or calls OneSignal.init', () => {
    const offenders = walk(join(ADMIN, 'src')).filter(f =>
      /react-onesignal|cdn\.onesignal\.com|OneSignal\.init|OneSignalDeferred/.test(
        readFileSync(f, 'utf8')
      )
    );
    expect(offenders).toEqual([]);
  });

  it('the admin does not depend on react-onesignal and ships no SDK worker', () => {
    const pkg = JSON.parse(readFileSync(join(ADMIN, 'package.json'), 'utf8'));
    expect({ ...pkg.dependencies, ...pkg.devDependencies }['react-onesignal']).toBeUndefined();
    expect(existsSync(join(ADMIN, 'public/OneSignalSDKWorker.js'))).toBe(false);
  });

  it('the admin CSP allowlists no onesignal host', () => {
    const csp = buildAdminCsp({
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
      pathname: '/stores/a/products',
      apiOrigin: 'https://api.ebda.app',
    });
    expect(csp).not.toMatch(/onesignal/i);
  });
});
