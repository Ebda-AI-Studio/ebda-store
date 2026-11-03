// @vitest-environment jsdom
/** P0 logout audit: a revoked session ends with a calm message and a same-origin return path, never silently. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSessionEndedUrl,
  handleSessionEnded,
  consumeSessionEnded,
  SESSION_ENDED_KEY,
} from './session-ended';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    },
  });
});

describe('buildSessionEndedUrl', () => {
  it('returns to the current admin path with the ended flag', () => {
    expect(buildSessionEndedUrl('/stores/abc/orders?tab=new')).toBe(
      '/login?returnTo=%2Fstores%2Fabc%2Forders%3Ftab%3Dnew&ended=1'
    );
  });
  it.each([['//evil.com/x'], ['https://evil.com'], ['/\\evil.com'], ['javascript:alert(1)'], ['']])(
    'drops an unsafe return path %j',
    p => {
      expect(buildSessionEndedUrl(p)).toBe('/login?ended=1');
    }
  );
  it('does not carry the login page itself as the return path', () => {
    expect(buildSessionEndedUrl('/login')).toBe('/login?ended=1');
  });
});

describe('handleSessionEnded', () => {
  it('redirects once, marks the flag, from a signed-in page', () => {
    const assign = vi.fn();
    handleSessionEnded({ pathname: '/stores/abc', search: '', assign });
    handleSessionEnded({ pathname: '/stores/abc', search: '', assign });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/login?returnTo=%2Fstores%2Fabc&ended=1');
    expect(mem.get(SESSION_ENDED_KEY)).toBe('1');
  });
  it('does nothing on a public page (a signed-out visitor was never "ended")', () => {
    const assign = vi.fn();
    handleSessionEnded({ pathname: '/login', search: '', assign });
    handleSessionEnded({ pathname: '/signup', search: '', assign });
    expect(assign).not.toHaveBeenCalled();
  });
  it('consumeSessionEnded reads the flag once', () => {
    mem.set(SESSION_ENDED_KEY, '1');
    expect(consumeSessionEnded()).toBe(true);
    expect(consumeSessionEnded()).toBe(false);
  });
});
