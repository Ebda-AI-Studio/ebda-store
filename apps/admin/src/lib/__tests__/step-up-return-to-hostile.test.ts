// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { postLoginDestination } from '../auth';

/**
 * The step-up / session-ended re-login carries the page as `returnTo`. Whatever an attacker puts there, the redirect after
 * sign-in must stay on this origin as a relative path (never `//host`, `/\host`, an absolute URL or a backslash form).
 */
const HOSTILE = [
  '//evil.com',
  '/\\evil.com',
  'https://evil.com',
  '/%5Cevil.com',
  '\\\\evil.com',
  'javascript:alert(1)',
  '/\t/evil.com',
];
const ORIGIN = 'https://admin.ebda.test';
const sameOriginRelative = (dest: string) => {
  expect(dest.startsWith('/')).toBe(true);
  expect(dest.startsWith('//')).toBe(false);
  expect(dest.startsWith('/\\')).toBe(false);
  expect(dest).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
  expect(new URL(dest, ORIGIN).origin).toBe(ORIGIN);
};

describe('postLoginDestination after a step-up re-login', () => {
  it.each(HOSTILE)('?returnTo=%j lands on a same-origin relative path', raw => {
    window.history.replaceState({}, '', `/login?returnTo=${encodeURIComponent(raw)}&stepup=1`);
    sameOriginRelative(postLoginDestination());
  });
  it('a legitimate returnTo is kept', () => {
    window.history.replaceState(
      {},
      '',
      `/login?returnTo=${encodeURIComponent('/stores/s1/staff?x=1')}&stepup=1`
    );
    expect(postLoginDestination()).toBe('/stores/s1/staff?x=1');
  });
});

describe('handleStepUpRequired builds only safe returnTo values', () => {
  it.each(HOSTILE)('pathname %j never reaches /login as an offsite returnTo', async raw => {
    vi.resetModules(); // the handler is one-shot per module instance
    const { handleStepUpRequired } = await import('../session-ended');
    const assign = vi.fn();
    await handleStepUpRequired(async () => undefined, { pathname: raw, search: '', assign });
    for (const [url] of assign.mock.calls) {
      expect(url.startsWith('/login')).toBe(true);
      const rt = new URL(url, ORIGIN).searchParams.get('returnTo');
      if (rt) sameOriginRelative(rt);
    }
  });
});
