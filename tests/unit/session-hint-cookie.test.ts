/**
 * The admin/orders "looks signed in" hint cookie is now `ebda-session`.
 * For one release the old name is still READ (so a deploy does not bounce
 * signed-in merchants) and CLEARED (so logout removes both). New sessions only
 * ever write the new name.
 */
import { describe, it, expect } from 'vitest';
import {
  SESSION_HINT_COOKIE,
  hasSessionHintCookie,
  sessionHintCookieSet,
  sessionHintCookieClears,
  LEGACY_SESSION_HINT_REMOVE_AFTER,
} from '@ebda/shared';

const LEGACY = ['force', 'session'].join('-');

describe('session hint cookie', () => {
  it('is named ebda-session', () => expect(SESSION_HINT_COOKIE).toBe('ebda-session'));

  it('reads the new cookie', () => {
    expect(hasSessionHintCookie('a=b; ebda-session=1; c=d')).toBe(true);
    expect(hasSessionHintCookie('ebda-session=1')).toBe(true);
  });

  it('still reads the pre-rename cookie (one-release fallback)', () => {
    expect(hasSessionHintCookie(`x=y; ${LEGACY}=1`)).toBe(true);
  });

  it('does not match look-alikes or other values', () => {
    expect(hasSessionHintCookie('my-ebda-session=1')).toBe(false);
    expect(hasSessionHintCookie('ebda-session=0')).toBe(false);
    expect(hasSessionHintCookie('')).toBe(false);
  });

  it('writes only the new name, and clears both', () => {
    expect(sessionHintCookieSet(60)).toBe('ebda-session=1; path=/; max-age=60; SameSite=Lax');
    const clears = sessionHintCookieClears();
    expect(clears).toContain('ebda-session=; path=/; max-age=0');
    expect(clears).toContain(`${LEGACY}=; path=/; max-age=0`);
  });

  it('carries a removal date', () => {
    expect(LEGACY_SESSION_HINT_REMOVE_AFTER).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
