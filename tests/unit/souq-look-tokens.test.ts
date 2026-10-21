// Phase B2 Task 1: the three Souq looks' tokens, the no-orange gate (Ruling B2-2) and the
// `souq` skin id registration. The gate has a negative control: it must flag the two colours
// the original Night souq design used (brass #C89B3C, lantern orange #E68245).
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  LOOKS,
  contrastRatio,
  composeStoreTheme,
  deriveBrandRoles,
  hexToHsl,
  TEMPLATE_THEMES,
  TEMPLATE_LAYOUT_BASELINES,
  TEMPLATES,
  SOUQ_NIGHT_ALT_BRASS,
} from '@ebda/shared';

const root = path.resolve(__dirname, '../..');
const souq = LOOKS.filter(l => l.template === 'souq');

/**
 * Ahmad 2026-10-16: no orange. Hue band 12-50 degrees at colour saturation >= 35% is forbidden.
 * Saturation here is HSV (chroma / max), NOT HSL: HSL saturation of a near-white cream reads
 * 50% for #F6F3EA (45 deg) although its chroma is 5% of its value, i.e. it is paper, not a
 * colour. The plan's own Night ink is that cream, so an HSL gate would flag the page's text.
 * `value` is a hex colour or a bare `H S% L%` triplet.
 */
const ORANGE_HUE: [number, number] = [12, 50];
const ORANGE_MIN_SAT = 0.35;
function toRgb(value: string): [number, number, number] {
  const v = value.trim();
  if (v.startsWith('#')) {
    const n = parseInt(v.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = v.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) throw new Error(`unparseable colour ${value}`);
  const [h, s, l] = [parseFloat(m[1]) / 360, parseFloat(m[2]) / 100, parseFloat(m[3]) / 100];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    const c =
      t < 1 / 6
        ? p + (q - p) * 6 * t
        : t < 1 / 2
          ? q
          : t < 2 / 3
            ? p + (q - p) * (2 / 3 - t) * 6
            : p;
    return Math.round(c * 255);
  };
  return s === 0
    ? [Math.round(l * 255), Math.round(l * 255), Math.round(l * 255)]
    : [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
export function isOrangeFamily(value: string): boolean {
  const [r, g, b] = toRgb(value);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0 || max === min) return false;
  const sat = (max - min) / max;
  const d = max - min;
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  return hue >= ORANGE_HUE[0] && hue <= ORANGE_HUE[1] && sat >= ORANGE_MIN_SAT;
}

describe('no-orange gate has teeth (negative control)', () => {
  it('flags the brass and the lantern orange the first Night souq design used', () => {
    expect(isOrangeFamily('#C89B3C')).toBe(true);
    expect(isOrangeFamily('#E68245')).toBe(true);
    expect(isOrangeFamily('#FF6E01')).toBe(true);
    expect(isOrangeFamily('#E8A33D')).toBe(true);
    // and the platform's default warning amber (45 93% 47%), which a Souq skin must replace
    expect(isOrangeFamily('45 93% 47%')).toBe(true);
  });
  it('passes the hues Souq actually uses', () => {
    // the cream ink (paper, 5% chroma) and the muted greens are not orange
    for (const c of [
      '#5FD3C0',
      '#E8606A',
      '#1F5FD6',
      '#1B61FF',
      '#0F3B2E',
      '#F6F3EA',
      '#B4CDC0',
      '45 40% 94%',
    ]) {
      expect(isOrangeFamily(c), c).toBe(false);
    }
  });
});

describe('souq looks: shape', () => {
  it('there are exactly three, on the souq skin, still designed until Task 7', () => {
    expect(souq.map(l => l.id).sort()).toEqual(['souq.catalogue', 'souq.night', 'souq.showroom']);
    for (const l of souq) {
      expect(l.skin, l.id).toBe('souq');
      expect(l.status, l.id).toBe('designed');
      expect(l.tokens.cardBadge, l.id).toBe('accent');
    }
  });
  it('card action and over-photo chrome follow the design', () => {
    const by = (id: string) => souq.find(l => l.id === id)!.tokens;
    expect(by('souq.catalogue').cardCta).toBeUndefined();
    expect(by('souq.night').cardCta).toBeUndefined();
    expect(by('souq.showroom').cardCta).toBe('quiet');
    expect(by('souq.night').overPhotoChrome).toBe('soft');
  });
  it('Night uses turquoise and pomegranate (Ruling B2-2), Showroom text blue is the darker one', () => {
    const night = souq.find(l => l.id === 'souq.night')!.tokens;
    expect(night.page).toBe('#0F3B2E');
    expect(night.primary).toBe('#5FD3C0');
    expect(night.accent).toBe('#E8606A');
    expect(souq.find(l => l.id === 'souq.showroom')!.tokens.accent).toBe('#1B61FF');
  });
});

describe('souq looks: skin-painted text pairs >= 4.5, UI pairs >= 3', () => {
  for (const l of souq) {
    const t = l.tokens;
    it.each([
      ['ink on page', t.page, t.ink],
      ['ink on surface', t.surface, t.ink],
      ['muted on page', t.page, t.muted],
      ['muted on surface', t.surface, t.muted],
      ['onPrimary on primary', t.primary, t.onPrimary],
      ['onAccent (or onPrimary) on accent', t.accent, t.onAccent ?? t.onPrimary],
    ])(`${l.id}: %s >= 4.5`, (_n, bg, fg) => {
      expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${l.id}: primary as text on page is >= 4.5, or the accent is the declared text role`, () => {
      const primaryText = contrastRatio(t.page, t.primary);
      const accentText = contrastRatio(t.page, t.accent);
      expect(Math.max(primaryText, t.onAccent ? 0 : accentText)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${l.id}: primary fill is a >= 3:1 UI boundary on the page and the surface`, () => {
      expect(contrastRatio(t.page, t.primary)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t.surface, t.primary)).toBeGreaterThanOrEqual(3);
    });
    it(`${l.id}: the composed input boundary (never the decorative line) is >= 3:1`, () => {
      const c = composeStoreTheme({ template: 'souq', look: l.id, theme: null });
      expect(
        contrastRatio(`hsl(${c.backgroundColor})`, `hsl(${c.inputColor})`)
      ).toBeGreaterThanOrEqual(3);
    });
  }
  it('Night: pomegranate is a FILL with dark ink, never a text colour on the page (3.75:1)', () => {
    const t = souq.find(l => l.id === 'souq.night')!.tokens;
    expect(contrastRatio(t.page, t.accent)).toBeLessThan(4.5);
    expect(t.onAccent).toBe(t.onPrimary);
    expect(contrastRatio(t.accent, t.onAccent!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Ruling B2-2: no orange anywhere in a Souq look', () => {
  for (const l of souq) {
    it(`${l.id}: no colour token is in the forbidden hue band`, () => {
      const t = l.tokens;
      for (const k of [
        'page',
        'surface',
        'ink',
        'muted',
        'primary',
        'onPrimary',
        'accent',
        'line',
      ] as const) {
        expect(isOrangeFamily(t[k]), `${l.id}.${k} ${t[k]}`).toBe(false);
      }
      if (t.onAccent) expect(isOrangeFamily(t.onAccent), `${l.id}.onAccent`).toBe(false);
    });
    it(`${l.id}: no composed theme colour (every role the look paints) is orange`, () => {
      const c = composeStoreTheme({ template: 'souq', look: l.id, theme: null }) as Record<
        string,
        unknown
      >;
      const colourKeys = Object.keys(c).filter(
        k =>
          /Color$|Foreground$/.test(k) &&
          typeof c[k] === 'string' &&
          /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(c[k] as string)
      );
      expect(colourKeys.length).toBeGreaterThan(10);
      for (const k of colourKeys)
        expect(isOrangeFamily(c[k] as string), `${l.id} ${k}=${c[k]}`).toBe(false);
    });
    it(`${l.id}: the sale / new chips (cardBadge accent pair) are not orange`, () => {
      const c = composeStoreTheme({ template: 'souq', look: l.id, theme: null });
      expect(isOrangeFamily(c.accentColor)).toBe(false);
      expect(isOrangeFamily(c.accentForeground)).toBe(false);
    });
  }
  it('the skin theme under the looks is not orange either', () => {
    for (const [k, v] of Object.entries(TEMPLATE_THEMES.souq)) {
      if (typeof v === 'string' && /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(v)) {
        expect(isOrangeFamily(v), k).toBe(false);
      }
    }
  });
});

describe('Souq replaces the platform amber warning', () => {
  const skin = TEMPLATE_THEMES.souq;
  it('the skin sets a non-orange warning pair that reads at AA', () => {
    expect(skin.warningColor).toBeDefined();
    expect(isOrangeFamily(skin.warningColor!)).toBe(false);
    expect(
      contrastRatio(`hsl(${skin.warningColor})`, `hsl(${skin.warningForeground})`)
    ).toBeGreaterThanOrEqual(4.5);
  });
  it('a composed Souq theme carries it; a legacy skin still carries the platform amber', () => {
    expect(
      composeStoreTheme({ template: 'souq', look: 'souq.night', theme: null }).warningColor
    ).toBe(skin.warningColor);
    expect(
      isOrangeFamily(composeStoreTheme({ template: 'minimal', theme: null }).warningColor)
    ).toBe(true);
  });
});

describe('the brass-for-CTAs alternative (STOP-1) is prepared but unwired', () => {
  const night = souq.find(l => l.id === 'souq.night')!.tokens;
  it('is not what the registry ships', () => {
    expect(SOUQ_NIGHT_ALT_BRASS.primary).toBe('#C89B3C');
    expect(night.primary).not.toBe(SOUQ_NIGHT_ALT_BRASS.primary);
  });
  it('keeps brass for CTAs only: accent stays pomegranate, brass CTA text is >= 4.5', () => {
    expect(SOUQ_NIGHT_ALT_BRASS.accent).toBe(night.accent);
    expect(
      contrastRatio(SOUQ_NIGHT_ALT_BRASS.page, SOUQ_NIGHT_ALT_BRASS.primary)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(SOUQ_NIGHT_ALT_BRASS.primary, SOUQ_NIGHT_ALT_BRASS.onPrimary)
    ).toBeGreaterThanOrEqual(4.5);
  });
  it('is only referenced by the STOP-1 shot script, never by runtime code', () => {
    const src = readFileSync(path.join(root, 'packages/shared/src/looks/registry.ts'), 'utf8');
    expect(src).toMatch(/SOUQ_NIGHT_ALT_BRASS/); // defined here
    expect(src.match(/SOUQ_NIGHT_ALT_BRASS/g)!.length).toBe(1);
  });
});

describe('merchant-extreme colours on souq looks', () => {
  const EXTREMES = ['#FFFFFF', '#000000', '#FFFF00', '#FF00FF', '#00FFFF', '#808080', '#777777'];
  const ratio = (surface: string, fgTriple: string) => contrastRatio(surface, `hsl(${fgTriple})`);
  for (const l of souq)
    for (const c of EXTREMES)
      it(`${l.id}: primary/accent ${c} keeps button and chip text legible`, () => {
        const theme = composeStoreTheme({
          template: 'souq',
          look: l.id,
          theme: { primaryColor: hexToHsl(c), accentColor: hexToHsl(c) },
        });
        const roles = deriveBrandRoles(theme);
        // Primary ink carries every buy / checkout label: held to AA by the guard (FU46-W1c-9).
        expect(ratio(c, roles['--primary-foreground'])).toBeGreaterThanOrEqual(4.5);
        // The accent pair keeps the guard's 2:1 floor for a deliberate stored pick (B1-24, unchanged).
        expect(ratio(c, roles['--accent-foreground'])).toBeGreaterThanOrEqual(2);
      });
  // A removed logo draws no token: the header falls back to the store name in --foreground on
  // --background, which is the ink-on-page pair asserted above for every look.
});

describe('souq skin id', () => {
  it('is a StoreTemplate enum value with an additive, single-statement migration', () => {
    const schema = readFileSync(path.join(root, 'packages/database/prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/enum StoreTemplate \{[^}]*\bsouq\b[^}]*\}/s);
    const mig = path.join(
      root,
      'packages/database/prisma/migrations/20261026000100_store_template_souq/migration.sql'
    );
    expect(existsSync(mig)).toBe(true);
    const sql = readFileSync(mig, 'utf8');
    expect(sql).toContain(`ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'souq';`);
    expect(sql).not.toMatch(/lock_timeout|DROP|UPDATE/i);
    expect(sql.replace(/--.*$/gm, '').match(/;/g)).toHaveLength(1);
  });
  it('has a theme, a baseline, a template entry and an Arabic label', () => {
    expect(TEMPLATE_THEMES.souq).toBeDefined();
    expect(TEMPLATE_LAYOUT_BASELINES.souq).toBeDefined();
    expect(TEMPLATES.find(t => t.id === 'souq')?.nameAr).toBe('سوق');
  });
  it('is registered in every web skin map and painted as data-pack', () => {
    for (const f of [
      'apps/web/src/templates/index.ts',
      'apps/web/src/templates/shared/pack-styles.ts',
      'apps/web/src/lib/serverTemplate.ts',
    ]) {
      expect(readFileSync(path.join(root, f), 'utf8'), f).toMatch(/\bsouq\b/);
    }
    expect(existsSync(path.join(root, 'apps/web/src/templates/souq/index.ts'))).toBe(true);
    expect(readFileSync(path.join(root, 'apps/web/src/app/layout.tsx'), 'utf8')).toMatch(
      /store\.template === 'souq'/
    );
  });
  it('labels the skin in admin (ar + en) without offering it as a bare skin (Ruling B1-17)', () => {
    for (const [f, label] of [
      ['apps/admin/src/i18n/messages/en.json', 'Souq'],
      ['apps/admin/src/i18n/messages/ar.json', 'سوق'],
    ]) {
      const json = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
      expect(json.template.page.skins.souq, f).toBe(label);
    }
    const svc = readFileSync(path.join(root, 'apps/api/src/services/store.service.ts'), 'utf8');
    expect(svc).toContain(
      "const validTemplates = ['modern', 'classic', 'minimal', 'bold', 'elegant', 'dahab'];"
    );
  });
  it('the souq template family renders on the souq skin', async () => {
    const { TEMPLATE_FAMILIES } = await import('@ebda/shared');
    expect(TEMPLATE_FAMILIES.find(f => f.id === 'souq')?.skin).toBe('souq');
  });
});

describe('Souq chrome paints no colour of its own (so the gate above stays true)', () => {
  const css = readFileSync(path.join(root, 'apps/web/src/styles/globals.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
  const souqRules = [...css.matchAll(/([^{}]*data-pack='souq'[^{}]*)\{([^}]*)\}/g)];
  it('there are souq pack rules, and none sets a colour literal or colour property', () => {
    expect(souqRules.length).toBeGreaterThanOrEqual(5);
    for (const [, sel, body] of souqRules) {
      expect(body, sel.trim()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
      expect(body, sel.trim()).not.toMatch(
        /(^|;|\s)(color|background(-color)?|border(-\w+)?-color)\s*:/
      );
    }
  });
  it('PACK_STYLES.souq uses only token colours (no arbitrary colour, no orange/amber/yellow/gold)', async () => {
    const { getPackStyles } = await import('../../apps/web/src/templates/shared/pack-styles');
    const all = Object.values(getPackStyles('souq')).join(' ');
    expect(all).not.toMatch(/\[#|rgb\(|hsl\(|\b(orange|amber|yellow|gold|brass|saffron)\b/i);
  });
});
