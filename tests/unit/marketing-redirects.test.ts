import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../apps');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('marketing redirects and hash forward (P1-9, P1-10, P1-12)', () => {
  it('every internal /store target carries the trailing slash so it is one hop', () => {
    const rules = read('marketing/public/_redirects')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'));
    const storeTargets = rules
      .map(l => l.split(/\s+/)[1])
      .filter(t => /^\/(en\/)?store/.test(t ?? ''));
    expect(storeTargets.length).toBeGreaterThan(0);
    for (const t of storeTargets) expect(t).toMatch(/^\/(en\/)?store\/(#.*)?$/);
  });
  it('the studio home loads hash-forward.js and the file forwards to /store/', () => {
    expect(existsSync(resolve(root, 'marketing/public/hash-forward.js'))).toBe(true);
    expect(read('marketing/src/components/StudioHome.tsx')).toContain('src="/hash-forward.js"');
    expect(read('marketing/public/hash-forward.js')).toContain("'/store/'");
  });
});

describe('help appPath targets exist (P0-2)', () => {
  it('account-security points at an admin route that exists', () => {
    for (const l of ['en', 'ar']) {
      expect(read(`help/content/${l}/account-security.mdx`)).toContain(
        'appPath: /account/security'
      );
    }
    expect(existsSync(resolve(root, 'admin/src/app/account/security'))).toBe(true);
  });
});
