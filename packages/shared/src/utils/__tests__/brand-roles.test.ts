import { describe, it, expect } from 'vitest';
import { deriveBrandRoles } from '../brand-roles';
import type { StoreTheme } from '../../types/store-theme';

// Minimal theme factory — only the fields deriveBrandRoles reads.
const theme = (over: Partial<StoreTheme> = {}): StoreTheme =>
  ({
    primaryColor: '348 68% 25%', // demo-shop maroon (dark)
    primaryForeground: '0 0% 100%',
    secondaryColor: '220 14% 96%',
    secondaryForeground: '220 9% 20%',
    accentColor: '24 100% 50%',
    accentForeground: '0 0% 100%',
    cardColor: '0 0% 100%', // white
    cardForeground: '0 0% 10%',
    foregroundColor: '0 0% 10%',
    mutedColor: '220 14% 96%',
    mutedForeground: '220 9% 46%',
    borderColor: '220 13% 91%',
    ...over,
  }) as StoreTheme;

describe('deriveBrandRoles', () => {
  it('preserves a stored foreground verbatim (demo-shop-immutability)', () => {
    const vars = deriveBrandRoles(theme());
    expect(vars['--primary']).toBe('348 68% 25%');
    expect(vars['--primary-foreground']).toBe('0 0% 100%'); // stored value, untouched
    expect(vars['--card']).toBe('0 0% 100%');
    expect(vars['--card-foreground']).toBe('0 0% 10%');
  });

  it('derives a readable foreground when none is stored', () => {
    // A new store set only a light card color, no card-foreground.
    const vars = deriveBrandRoles(
      theme({ cardColor: '0 0% 100%', cardForeground: undefined as unknown as string })
    );
    // pickReadableForeground(white) → black; emitted as an hsl-triple our CSS expects.
    expect(vars['--card-foreground']).toBe('0 0% 0%');
  });

  it('derives a readable foreground when the stored one is unreadable on its surface', () => {
    // Stored white foreground on a white card = invisible. Engine overrides to readable.
    const vars = deriveBrandRoles(theme({ cardColor: '0 0% 100%', cardForeground: '0 0% 100%' }));
    expect(vars['--card-foreground']).toBe('0 0% 0%'); // forced to black (was unreadable white)
  });

  it('keeps a deliberate readable foreground (does not over-correct)', () => {
    // Maroon bg + white text reads fine (≈AA) → keep the stored white.
    const vars = deriveBrandRoles(
      theme({ primaryColor: '348 68% 25%', primaryForeground: '0 0% 100%' })
    );
    expect(vars['--primary-foreground']).toBe('0 0% 100%');
  });

  it('CALIBRATION: a fully-configured theme is returned unchanged (demo-shop gate)', () => {
    // Spec §7: a fully-configured theme (all foregrounds stored + readable)
    // must come out byte-identical. This is the hard constraint — demo-shop
    // does not move. If this fails, the engine is over-correcting.
    const demoTheme = theme(); // all *Color + readable *Foreground set
    const vars = deriveBrandRoles(demoTheme);
    expect(vars['--primary']).toBe(demoTheme.primaryColor);
    expect(vars['--primary-foreground']).toBe(demoTheme.primaryForeground);
    expect(vars['--secondary']).toBe(demoTheme.secondaryColor);
    expect(vars['--secondary-foreground']).toBe(demoTheme.secondaryForeground);
    expect(vars['--accent']).toBe(demoTheme.accentColor);
    expect(vars['--accent-foreground']).toBe(demoTheme.accentForeground);
    expect(vars['--card']).toBe(demoTheme.cardColor);
    expect(vars['--card-foreground']).toBe(demoTheme.cardForeground);
  });
});
