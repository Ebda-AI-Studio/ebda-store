import { describe, it, expect } from 'vitest';
import type { StoreTheme } from '@force/shared';
import { getCustomBadgeTextColor } from './custom-badge';

// Issue #2129 — a token pick must get the platform's PAIRED foreground, not
// hardcoded white (white on a pale primary is ~1.2:1, the #1614 defect).
const THEME = { primaryColor: '40 90% 90%' } as unknown as StoreTheme;

describe('getCustomBadgeTextColor', () => {
  it.each(['primary', 'secondary', 'accent', 'card', 'muted'])(
    'token:%s → its paired --<token>-foreground var',
    token => {
      expect(getCustomBadgeTextColor(`token:${token}`, THEME)).toBe(
        `hsl(var(--${token}-foreground))`
      );
    }
  );

  it('token with no paired var (foreground/border) keeps white', () => {
    expect(getCustomBadgeTextColor('token:foreground', THEME)).toBe('#ffffff');
    expect(getCustomBadgeTextColor('token:border', THEME)).toBe('#ffffff');
  });

  it('a raw hex pick keeps white (unchanged design decision)', () => {
    expect(getCustomBadgeTextColor('#b91c1c', THEME)).toBe('#ffffff');
  });

  it('unset → primary-foreground (the #1614 pairing)', () => {
    expect(getCustomBadgeTextColor(undefined, THEME)).toBe('hsl(var(--primary-foreground))');
  });

  it('an unknown token is not treated as paired', () => {
    expect(getCustomBadgeTextColor('token:nope', THEME)).toBe('hsl(var(--primary-foreground))');
  });
});
