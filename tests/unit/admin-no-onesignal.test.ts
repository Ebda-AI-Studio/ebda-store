/**
 * Audit G-1 (2026-11-03) + follow-up: the OneSignal push SDK must NOT load on admin page load (it injected an English
 * opt-in card over the editor and intercepted clicks on its tabs). Merchant order alerts stay available as an explicit
 * opt-in: only a click on the "enable order alerts" button lazy-loads the SDK, only on the two routes that carry it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildAdminCsp, PUSH_OPT_IN_PATH } from '../../apps/admin/src/lib/csp';

const ADMIN = join(__dirname, '../../apps/admin');
const OPT_IN_MODULE = 'lib/push-opt-in.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e === '.open-next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(e) && !/\.test\./.test(e)) out.push(p);
  }
  return out;
}
const src = join(ADMIN, 'src');
const rel = (f: string) => f.slice(src.length + 1);

describe('OneSignal loads only after the explicit opt-in click', () => {
  it('the SDK is imported in ONE module, dynamically, never statically', () => {
    const importers = walk(src).filter(f => /react-onesignal/.test(readFileSync(f, 'utf8')));
    expect(importers.map(rel)).toEqual([OPT_IN_MODULE]);
    const body = readFileSync(join(src, OPT_IN_MODULE), 'utf8');
    expect(body).toMatch(/await import\('react-onesignal'\)/);
    expect(body).not.toMatch(/^import .* from 'react-onesignal'/m);
  });

  it('no provider, layout or page-load module touches the opt-in or the SDK', () => {
    for (const f of [
      'app/providers.tsx',
      'app/layout.tsx',
      'components/AdminLayout.tsx',
      'middleware.ts',
    ]) {
      const t = readFileSync(join(src, f), 'utf8');
      expect(t, f).not.toMatch(/push-opt-in|react-onesignal|OneSignalInit|enableOrderAlerts/);
    }
  });

  it('only the opt-in button calls enableOrderAlerts, and only from a click handler', () => {
    const callers = walk(src).filter(
      f => rel(f) !== OPT_IN_MODULE && /enableOrderAlerts\(/.test(readFileSync(f, 'utf8'))
    );
    expect(callers.map(rel).sort()).toEqual([
      'components/EnableOrderAlertsButton.tsx',
      'components/OrderAlertsPromptCard.tsx',
    ]);
    for (const f of callers) {
      const body = readFileSync(f, 'utf8');
      expect(body, rel(f)).toMatch(/onClick=\{enable\}/);
      // the only call sits inside the click handler, never inside an effect
      expect(body.match(/enableOrderAlerts\(/g)?.length, rel(f)).toBe(1);
      expect(body, rel(f)).toMatch(/async function enable\(\) \{[\s\S]*?await enableOrderAlerts\(/);
      expect(body.replace(/async function enable\(\) \{[\s\S]*$/, ''), rel(f)).not.toMatch(
        /enableOrderAlerts\(/
      );
    }
  });

  it('keeps the dependency and the service worker so existing subscriptions keep working', () => {
    const pkg = JSON.parse(readFileSync(join(ADMIN, 'package.json'), 'utf8'));
    expect(pkg.dependencies['react-onesignal']).toBeDefined();
    expect(existsSync(join(ADMIN, 'public/OneSignalSDKWorker.js'))).toBe(true);
  });
});

describe('CSP: onesignal hosts only on the opt-in routes', () => {
  const csp = (pathname: string) =>
    buildAdminCsp({
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
      pathname,
      apiOrigin: 'https://api.ebda.app',
    });

  it.each(['/', '/login', '/stores/a/products', '/stores/a/builder', '/stores/a/notifications/x'])(
    '%s has no onesignal host',
    p => {
      expect(csp(p)).not.toMatch(/onesignal/i);
    }
  );

  it.each(['/account/devices', '/stores/abc/notifications'])('%s allows the SDK hosts', p => {
    expect(PUSH_OPT_IN_PATH.test(p)).toBe(true);
    const c = csp(p);
    expect(c).toMatch(/script-src[^;]*https:\/\/cdn\.onesignal\.com/);
    expect(c).toMatch(/connect-src[^;]*https:\/\/onesignal\.com/);
    expect(c).toMatch(/frame-src https:\/\/onesignal\.com/);
  });
});
