/**
 * The admin consumes the vendored foundation tokens (@ebda/shared/design) instead of keeping its own copy.
 * This test proves every admin class / CSS variable that restates a foundation value still equals it, that the
 * brand colours are not orange, and that there is one font family. Change a value in ebda-foundation, never here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  CONTROL,
  FONT,
  MOTION,
  NAV,
  RADIUS,
  TOKENS,
  TYPE as FDN_TYPE,
  isOrange,
} from '@ebda/shared/design';
import {
  TYPE,
  navItemClasses,
  bottomNavClasses,
  CONTROL_HEIGHT,
  NAV_HEIGHT,
  RADIUS_PX,
} from '../../apps/admin/src/components/ui/tokens';

const ADMIN = join(__dirname, '../../apps/admin');
const css = readFileSync(join(ADMIN, 'src/styles/globals.css'), 'utf8');
const layout = readFileSync(join(ADMIN, 'src/app/layout.tsx'), 'utf8');
const req = createRequire(import.meta.url);
const tw = req('tailwindcss/defaultTheme') as { fontSize: Record<string, [string, unknown]> };

/** `36.4 36.03% 51.57%` -> `#rrggbb` */
function hslToHex(v: string): string {
  const [h, s, l] = v.match(/[\d.]+/g)!.map(Number) as [number, number, number];
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
const roles = (block: string) =>
  [...block.matchAll(/--([\w-]+):\s*([\d.]+ [\d.]+% [\d.]+%)\s*;/g)].map(m => ({
    name: m[1]!,
    hex: hslToHex(m[2]!),
  }));

describe('admin consumes the foundation tokens', () => {
  it('globals.css imports the vendored variables and derives radius + motion from them', () => {
    expect(css).toMatch(/@import '[./]+packages\/shared\/src\/foundation\/tokens\.css';/);
    expect(css).toContain('--radius: var(--ebda-radius-surface);');
    for (const k of ['fast', 'base', 'slow'])
      expect(css).toContain(`--dur-${k}: var(--ebda-dur-${k});`);
    expect(css).toContain('--ease-out: var(--ebda-ease);');
    const vendored = readFileSync(
      join(__dirname, '../../packages/shared/src/foundation/tokens.css'),
      'utf8'
    );
    expect(vendored).toContain(`--ebda-radius-surface: ${RADIUS.surface}px;`);
    expect(vendored).toContain(`--ebda-dur-base: ${MOTION.base}ms;`);
  });

  it('every type class is the foundation px size and the RTL leading is the foundation Arabic leading', () => {
    for (const [name, t] of Object.entries(TYPE)) {
      const fdn = FDN_TYPE[name as keyof typeof FDN_TYPE];
      expect(t.px, name).toBe(fdn.px);
      expect(t.leading, name).toEqual(fdn.leading);
      const cls = t.cls.replace('text-', '');
      expect(parseFloat(tw.fontSize[cls]![0]) * 16, `tailwind ${t.cls}`).toBe(fdn.px);
      const m = css.match(
        new RegExp(`\\[dir='rtl'\\] \\.${t.cls} \\{\\s*line-height: ([\\d.]+)rem;`)
      );
      expect(m, `rtl leading for ${t.cls}`).not.toBeNull();
      expect(parseFloat(m![1]!) * 16, `rtl leading ${t.cls}`).toBe(fdn.leading[1]);
    }
  });

  it('nav and control heights are the foundation heights (tailwind n = 4n px)', () => {
    expect(CONTROL_HEIGHT).toBe(CONTROL);
    expect(NAV_HEIGHT).toBe(NAV);
    const px = (cls: string, from: string) =>
      Number(from.match(new RegExp(`(?:^| )${cls}-(\\d+)(?= |$)`))![1]) * 4;
    expect(px('min-h', navItemClasses({ kind: 'sidebar', active: false }))).toBe(NAV.sidebar);
    expect(
      px('min-h', navItemClasses({ kind: 'tab', active: false }).replace('md:min-h-10', ''))
    ).toBe(NAV.tabPhone);
    expect(navItemClasses({ kind: 'tab', active: false })).toContain(`md:min-h-${NAV.tab / 4}`);
    expect(px('min-h', navItemClasses({ kind: 'rail', active: false }))).toBe(NAV.rail);
    expect(px('h', bottomNavClasses(false))).toBe(NAV.bottom);
  });

  it('radius: --radius is the surface radius and rounded-md is the control radius', () => {
    expect(RADIUS_PX).toBe(RADIUS);
    expect(RADIUS.surface - 2).toBe(RADIUS.control); // tailwind borderRadius.md = calc(var(--radius) - 2px)
  });

  it('brand colours are not orange; the primary is Ebda gold; no orange, blue or violet chrome role besides the info role', () => {
    const light = css.match(/:root \{([\s\S]*?)\n  \}/)![1]!;
    const dark = css.match(/\.dark \{([\s\S]*?)\n  \}/)![1]!;
    expect(
      roles(light)
        .find(r => r.name === 'primary')!
        .hex.toLowerCase()
    ).toBe(TOKENS.gold.toLowerCase());
    for (const r of [...roles(light), ...roles(dark)])
      expect(isOrange(r.hex), `--${r.name} ${r.hex}`).toBe(false);
  });

  it('one font family: the admin loads IBM Plex Sans Arabic for Arabic and Latin and no other next/font face', () => {
    expect(FONT.family).toBe('IBM Plex Sans Arabic');
    expect(
      [...layout.matchAll(/import \{ (\w+) \} from 'next\/font\/google'/g)].map(m => m[1])
    ).toEqual(['IBM_Plex_Sans_Arabic']);
    expect(layout).toContain("subsets: ['arabic', 'latin']");
  });
});
