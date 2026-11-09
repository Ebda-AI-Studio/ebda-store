// Phase B3 Task 1: the three Jasmine looks' tokens, the no-orange gate (Rulings B2-2, B3-2,
// B3-3) and the `jasmine` skin id registration. The gate has negative controls: it must flag
// the amber the original Apothecary design used (#C9822B), the lantern orange (#E68245) and the
// brown ground the plan first proposed (#2E2A22, measured 41 deg / 26% HSV saturation).
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
  TEMPLATE_FAMILIES,
  themeToCssVars,
} from '@ebda/shared';
import { isOrangeFamily, isForbiddenOrange } from './helpers/orange-gate';

const root = path.resolve(__dirname, '../..');
const jasmine = LOOKS.filter(l => l.template === 'jasmine');
const triplet = /^-?[\d.]+\s+[\d.]+%\s+[\d.]+%$/;

describe('no-orange gate has teeth (negative control)', () => {
  it('flags the amber, the lantern orange, brass and the brown ground', () => {
    for (const c of ['#C9822B', '#E68245', '#D9984A', '#FF6E01', '#C89B3C', '#2E2A22', '#3A352B'])
      expect(isOrangeFamily(c), c).toBe(true);
  });
  it('passes the hues Jasmine actually uses', () => {
    for (const c of [
      '#24291C',
      '#2E3425',
      '#F3EFE6',
      '#C9CDB8',
      '#4A5240',
      '#8FC9AE',
      '#14180F',
      '#F6D7DC',
      '#B0154F',
      '#3A1E2A',
      '#1B7A67',
      '#E6F5F2',
      '#13212B',
    ])
      expect(isOrangeFamily(c), c).toBe(false);
  });
});

describe('jasmine looks: shape', () => {
  it('there are exactly three, on the jasmine skin', () => {
    expect(jasmine.map(l => l.id).sort()).toEqual([
      'jasmine.apothecary',
      'jasmine.bloom',
      'jasmine.clinic',
    ]);
    for (const l of jasmine) {
      expect(l.skin, l.id).toBe('jasmine');
      expect(['designed', 'built']).toContain(l.status);
      expect(l.tokens.cardBadge, l.id).toBe('accent');
    }
  });
  it('card action and over-photo chrome follow the design', () => {
    const by = (id: string) => jasmine.find(l => l.id === id)!.tokens;
    expect(by('jasmine.apothecary').cardCta).toBeUndefined();
    expect(by('jasmine.apothecary').overPhotoChrome).toBe('soft');
    expect(by('jasmine.clinic').cardCta).toBe('quiet');
    expect(by('jasmine.bloom').radius).toBe('lg');
  });
  it('Apothecary: olive ground, paper ink, brass CTA with olive-black ink (Ruling B3-2)', () => {
    const t = jasmine.find(l => l.id === 'jasmine.apothecary')!.tokens;
    expect(t.page).toBe('#24291C');
    expect(t.ink).toBe('#F3EFE6');
    expect(t.primary).toBe('#C89B3C');
    expect(t.onPrimary).toBe('#14180F');
  });
});

describe('jasmine looks: painted text pairs >= 4.5, UI pairs >= 3', () => {
  for (const l of jasmine) {
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
    it(`${l.id}: primary is a >= 3:1 UI boundary and >= 4.5:1 as text on the page and the surface`, () => {
      expect(contrastRatio(t.page, t.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.surface, t.primary)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${l.id}: accent reads as text and as a boundary on page and surface`, () => {
      expect(contrastRatio(t.page, t.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.surface, t.accent)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${l.id}: the composed input boundary (never the decorative line) is >= 3:1`, () => {
      const c = composeStoreTheme({ template: 'jasmine', look: l.id, theme: null });
      expect(
        contrastRatio(`hsl(${c.backgroundColor})`, `hsl(${c.inputColor})`)
      ).toBeGreaterThanOrEqual(3);
    });
  }
  it('Apothecary: the decorative line stays under 3:1, so it can never draw an interactive boundary', () => {
    const t = jasmine.find(l => l.id === 'jasmine.apothecary')!.tokens;
    expect(contrastRatio(t.page, t.line)).toBeLessThan(3);
  });
});

const BRASS = '#C89B3C';
const BRASS_TRIPLET = hexToHsl(BRASS);
/** Ruling METAL-1: one rule (`isMetal`, helpers/orange-gate.ts) replaces the per-look brass exceptions. */
const forbiddenOrange = (_lookId: string, _key: string, value: string) => isForbiddenOrange(value);

describe('Rulings B2-2 / B3-2 / B3-3: no orange anywhere in a Jasmine look', () => {
  for (const l of jasmine) {
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
      ] as const)
        expect(forbiddenOrange(l.id, k, t[k]), `${l.id}.${k} ${t[k]}`).toBe(false);
      if (t.onAccent) expect(isOrangeFamily(t.onAccent), `${l.id}.onAccent`).toBe(false);
    });
    it(`${l.id}: no composed theme colour (every role the look paints) is orange`, () => {
      const c = composeStoreTheme({ template: 'jasmine', look: l.id, theme: null }) as Record<
        string,
        unknown
      >;
      const keys = Object.keys(c).filter(
        k =>
          /Color$|Foreground$/.test(k) && typeof c[k] === 'string' && triplet.test(c[k] as string)
      );
      expect(keys.length).toBeGreaterThan(10);
      for (const k of keys)
        expect(forbiddenOrange(l.id, k, c[k] as string), `${l.id} ${k}=${c[k]}`).toBe(false);
    });
    it(`${l.id}: every CSS variable the theme emits is outside the band`, () => {
      const theme = composeStoreTheme({ template: 'jasmine', look: l.id, theme: null });
      const vars = themeToCssVars(theme, l.id) as Record<string, string>;
      const colourVars = Object.entries(vars).filter(([, v]) => triplet.test(v));
      expect(colourVars.length).toBeGreaterThan(20);
      expect(colourVars.map(([k]) => k)).toContain('--warning-ink');
      const bad = colourVars
        .filter(([k, v]) => forbiddenOrange(l.id, k, v))
        .map(([k, v]) => `${k}=${v}`);
      expect(bad).toEqual([]);
    });
  }
  it('the skin theme under the looks is not orange either', () => {
    for (const [k, v] of Object.entries(TEMPLATE_THEMES.jasmine))
      if (typeof v === 'string' && triplet.test(v)) expect(isOrangeFamily(v), k).toBe(false);
  });
  it('negative control: a legacy skin emits an orange --warning-ink, so the check can fail', () => {
    const theme = composeStoreTheme({ template: 'qamar', look: null, theme: null });
    const vars = themeToCssVars(theme) as Record<string, string>;
    expect(isOrangeFamily(vars['--warning-ink'])).toBe(true);
  });
  it('Jasmine replaces the platform amber warning with an AA plum', () => {
    const skin = TEMPLATE_THEMES.jasmine;
    expect(isOrangeFamily(skin.warningColor!)).toBe(false);
    expect(
      contrastRatio(`hsl(${skin.warningColor})`, `hsl(${skin.warningForeground})`)
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe('merchant-extreme colours on jasmine looks', () => {
  const EXTREMES = ['#FFFFFF', '#000000', '#FFFF00', '#FF00FF', '#00FFFF', '#808080', '#777777'];
  const ratio = (surface: string, fg: string) => contrastRatio(surface, `hsl(${fg})`);
  for (const l of jasmine)
    for (const c of EXTREMES)
      it(`${l.id}: primary/accent ${c} keeps button and chip text legible`, () => {
        const theme = composeStoreTheme({
          template: 'jasmine',
          look: l.id,
          theme: { primaryColor: hexToHsl(c), accentColor: hexToHsl(c) },
        });
        const roles = deriveBrandRoles(theme);
        expect(ratio(c, roles['--primary-foreground'])).toBeGreaterThanOrEqual(4.5);
        expect(ratio(c, roles['--accent-foreground'])).toBeGreaterThanOrEqual(2);
      });
});

describe('jasmine skin id', () => {
  it('is a StoreTemplate enum value with an additive, single-statement migration', () => {
    const schema = readFileSync(path.join(root, 'packages/database/prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/enum StoreTemplate \{[^}]*\bjasmine\b[^}]*\}/s);
    const mig = path.join(
      root,
      'packages/database/prisma/migrations/20261030000100_store_template_jasmine/migration.sql'
    );
    expect(existsSync(mig)).toBe(true);
    const sql = readFileSync(mig, 'utf8');
    expect(sql).toContain(`ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'jasmine';`);
    expect(sql).not.toMatch(/lock_timeout|DROP|UPDATE/i);
    expect(sql.replace(/--.*$/gm, '').match(/;/g)).toHaveLength(1);
  });
  it('has a theme, a baseline, a template entry and an Arabic label', () => {
    expect(TEMPLATE_THEMES.jasmine).toBeDefined();
    expect(TEMPLATE_LAYOUT_BASELINES.jasmine).toBeDefined();
    expect(TEMPLATES.find(t => t.id === 'jasmine')?.nameAr).toBe('ياسمين');
  });
  it('is registered in every web skin map and painted as data-pack', () => {
    for (const f of [
      'apps/web/src/templates/index.ts',
      'apps/web/src/templates/shared/pack-styles.ts',
      'apps/web/src/lib/serverTemplate.ts',
    ])
      expect(readFileSync(path.join(root, f), 'utf8'), f).toMatch(/\bjasmine\b/);
    expect(existsSync(path.join(root, 'apps/web/src/templates/jasmine/index.ts'))).toBe(true);
    expect(readFileSync(path.join(root, 'apps/web/src/app/layout.tsx'), 'utf8')).toMatch(
      /store\.template === 'jasmine'/
    );
  });
  it('labels the skin in admin (ar + en) without offering it as a bare skin (Ruling B1-17)', () => {
    for (const [f, label] of [
      ['apps/admin/src/i18n/messages/en.json', 'Jasmine'],
      ['apps/admin/src/i18n/messages/ar.json', 'ياسمين'],
    ]) {
      const json = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
      expect(json.template.page.skins.jasmine, f).toBe(label);
    }
    // UX:T-1: /template is a redirect to the editor, whose look switcher picks the skin; the label lives in the messages above.
    const page = readFileSync(
      path.join(root, 'apps/admin/src/app/stores/[id]/template/page.tsx'),
      'utf8'
    );
    expect(page).toContain('/builder');
  });
  it('the jasmine template family renders on the jasmine skin', () => {
    expect(TEMPLATE_FAMILIES.find(f => f.id === 'jasmine')?.skin).toBe('jasmine');
  });
});
