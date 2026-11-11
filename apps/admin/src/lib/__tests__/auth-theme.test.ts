// @vitest-environment jsdom
/**
 * The signed-out pages are pinned to the light split layout (Ahmad, 2026-11-10); the dashboard stays
 * dark-first. The root layout's pre-paint script is the half that decides the first paint.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLightPinnedPath, THEME_INIT_SCRIPT } from '../auth-theme';

function runInitScript(pathname: string, saved: string | null) {
  document.documentElement.classList.remove('dark');
  window.history.replaceState(null, '', pathname);
  vi.stubGlobal('localStorage', { getItem: () => saved });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('dark'), media: q }));
  new Function(THEME_INIT_SCRIPT)();
  return document.documentElement.classList.contains('dark');
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
});

describe('THEME_INIT_SCRIPT', () => {
  const authPaths = [
    '/login',
    '/login/',
    '/signup',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/accept-invite',
    '/onboarding',
  ];
  for (const p of authPaths) {
    it(`never paints ${p} dark, even with a dark device and a saved dark theme`, () => {
      expect(runInitScript(p, null)).toBe(false);
      expect(runInitScript(p, 'dark')).toBe(false);
    });
  }

  it('keeps the dashboard dark-first and honours a saved light theme', () => {
    expect(runInitScript('/dashboard', null)).toBe(true);
    expect(runInitScript('/stores/1/orders', 'dark')).toBe(true);
    expect(runInitScript('/dashboard', 'light')).toBe(false);
  });

  it('does not pin look-alike paths', () => {
    expect(isLightPinnedPath('/login-history')).toBe(false);
    expect(isLightPinnedPath('/stores/1/signup-form')).toBe(false);
  });

  it('is the script the root layout actually runs', () => {
    const layout = readFileSync(join(__dirname, '../../app/layout.tsx'), 'utf8');
    expect(layout).toMatch(/__html:\s*THEME_INIT_SCRIPT/);
  });
});
