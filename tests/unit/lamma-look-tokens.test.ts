// Phase B4 Task 1: the three Lamma looks' tokens, the no-orange gate (Rulings B2-2, B4-2) and the
// `lamma` skin id registration. The gate has negative controls: it must flag the saffron the
// Notebook direction used (#E0A526), the terracotta of the Family table (#B5482E), the market's
// saffron section colour (#F2B632) and a desaturated in-band tan that is NOT the declared metal
// (#C8A06A). Brass `#D3B87C` is the ONE scoped metal exception, on exactly lamma.notebook.
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
const lamma = LOOKS.filter(l => l.template === 'lamma');
const triplet = /^-?[\d.]+\s+[\d.]+%\s+[\d.]+%$/;

describe('no-orange gate has teeth (negative control, Ruling B4-2)', () => {
  it('flags the saffron, the terracotta, the market saffron and an undeclared tan', () => {
    for (const c of ['#E0A526', '#B5482E', '#F2B632', '#C8A06A', '#D3B87C'])
      expect(isOrangeFamily(c), c).toBe(true);
  });
  it('passes the hues Lamma actually uses', () => {
    for (const c of [
      '#A5303F',
      '#FBF1F2',
      '#EBD6DA',
      '#2B1A1F',
      '#62505A',
      '#2F6B34',
      '#1F3D2B',
      '#29503A',
      '#F5F7F2',
      '#C3D3C8',
      '#345E46',
      '#23744A',
      '#CC2F3F',
      '#5B2A6E',
      '#0F7F8C',
      '#1B1B1B',
      '#575757',
      '#f2e2e4',
      '#e0ece6',
      '#ebe5ee',
      '#ddedef',
    ])
      expect(isOrangeFamily(c), c).toBe(false);
  });
});

describe('lamma looks: shape', () => {
  it('there are exactly three, on the lamma skin', () => {
    expect(lamma.map(l => l.id).sort()).toEqual(['lamma.market', 'lamma.notebook', 'lamma.table']);
    for (const l of lamma) {
      expect(l.skin, l.id).toBe('lamma');
      expect(['designed', 'built']).toContain(l.status);
      expect(l.tokens.cardBadge, l.id).toBe('accent');
    }
  });
  it('card action and over-photo chrome follow the design', () => {
    const by = (id: string) => lamma.find(l => l.id === id)!.tokens;
    expect(by('lamma.table').cardCta).toBeUndefined();
    expect(by('lamma.market').cardCta).toBeUndefined();
    expect(by('lamma.notebook').cardCta).toBe('quiet');
    expect(by('lamma.notebook').overPhotoChrome).toBe('soft');
    expect(by('lamma.market').radius).toBe('lg');
    expect(by('lamma.market').imageRatio).toBe('1/1');
  });
  it('the tokens are exactly the re-derived ones of Ruling B4-2', () => {
    const by = (id: string) => lamma.find(l => l.id === id)!.tokens;
    const table = by('lamma.table');
    expect([
      table.primary,
      table.surface,
      table.ink,
      table.muted,
      table.accent,
      table.line,
    ]).toEqual(['#A5303F', '#FBF1F2', '#2B1A1F', '#62505A', '#3E7A3A', '#EBD6DA']);
    const nb = by('lamma.notebook');
    expect([nb.page, nb.surface, nb.ink, nb.muted, nb.primary, nb.accent, nb.line]).toEqual([
      '#1F3D2B',
      '#29503A',
      '#F5F7F2',
      '#C3D3C8',
      '#D3B87C',
      '#D3B87C',
      '#345E46',
    ]);
    const mk = by('lamma.market');
    expect([mk.primary, mk.accent, mk.surface, mk.ink, mk.muted]).toEqual([
      '#23744A',
      '#CC2F3F',
      '#F4F4F4',
      '#1B1B1B',
      '#575757',
    ]);
  });
});

describe('lamma looks: painted text pairs >= 4.5, UI pairs >= 3', () => {
  for (const l of lamma) {
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
    it(`${l.id}: primary reads as text on the page and the surface`, () => {
      expect(contrastRatio(t.page, t.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.surface, t.primary)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${l.id}: accent reads as text and as a boundary on page and surface`, () => {
      expect(contrastRatio(t.page, t.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.surface, t.accent)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${l.id}: the composed input boundary (never the decorative line) is >= 3:1`, () => {
      const c = composeStoreTheme({ template: 'lamma', look: l.id, theme: null });
      expect(
        contrastRatio(`hsl(${c.backgroundColor})`, `hsl(${c.inputColor})`)
      ).toBeGreaterThanOrEqual(3);
    });
  }
  it('the decorative line stays under 3:1 on the Family table and the Notebook, so it can never draw an interactive boundary', () => {
    for (const id of ['lamma.table', 'lamma.notebook']) {
      const t = lamma.find(l => l.id === id)!.tokens;
      expect(contrastRatio(t.page, t.line), id).toBeLessThan(3);
    }
  });
  it('Notebook: a merchant white-background photo needs the light band, whose ink clears 4.5 (token half of § 9 rule 1)', () => {
    const c = composeStoreTheme({ template: 'lamma', look: 'lamma.notebook', theme: null });
    const vars = themeToCssVars(c, 'lamma.notebook') as Record<string, string>;
    // the `inverse` surface the dish band paints on: the page ink as ground, the page as text
    const t = lamma.find(l => l.id === 'lamma.notebook')!.tokens;
    expect(contrastRatio(t.ink, t.page)).toBeGreaterThanOrEqual(4.5);
    expect(Object.keys(vars).length).toBeGreaterThan(20);
  });
});

const BRASS = '#D3B87C';
const BRASS_TRIPLET = hexToHsl(BRASS);
/** Ruling METAL-1: one rule (`isMetal`, helpers/orange-gate.ts) replaces the per-look brass exceptions. */
const forbiddenOrange = (_lookId: string, _key: string, value: string) => isForbiddenOrange(value);

describe('Rulings B2-2 / B4-2: no orange anywhere in a Lamma look', () => {
  for (const l of lamma) {
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
      const c = composeStoreTheme({ template: 'lamma', look: l.id, theme: null }) as Record<
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
      const theme = composeStoreTheme({ template: 'lamma', look: l.id, theme: null });
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
    for (const [k, v] of Object.entries(TEMPLATE_THEMES.lamma))
      if (typeof v === 'string' && triplet.test(v)) expect(isOrangeFamily(v), k).toBe(false);
  });
  it('negative control: a legacy skin emits an orange --warning-ink, so the check can fail', () => {
    const theme = composeStoreTheme({ template: 'qamar', look: null, theme: null });
    const vars = themeToCssVars(theme) as Record<string, string>;
    expect(isOrangeFamily(vars['--warning-ink'])).toBe(true);
  });
  it('Lamma replaces the platform amber warning with an AA plum', () => {
    const skin = TEMPLATE_THEMES.lamma;
    expect(isOrangeFamily(skin.warningColor!)).toBe(false);
    expect(
      contrastRatio(`hsl(${skin.warningColor})`, `hsl(${skin.warningForeground})`)
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe('merchant-extreme colours on lamma looks', () => {
  const EXTREMES = ['#FFFFFF', '#000000', '#FFFF00', '#FF00FF', '#00FFFF', '#808080', '#777777'];
  const ratio = (surface: string, fg: string) => contrastRatio(surface, `hsl(${fg})`);
  for (const l of lamma)
    for (const c of EXTREMES)
      it(`${l.id}: primary/accent ${c} keeps button and chip text legible`, () => {
        const theme = composeStoreTheme({
          template: 'lamma',
          look: l.id,
          theme: { primaryColor: hexToHsl(c), accentColor: hexToHsl(c) },
        });
        const roles = deriveBrandRoles(theme);
        expect(ratio(c, roles['--primary-foreground'])).toBeGreaterThanOrEqual(4.5);
        expect(ratio(c, roles['--accent-foreground'])).toBeGreaterThanOrEqual(2);
      });
});

describe('lamma skin id', () => {
  it('is a StoreTemplate enum value with an additive, single-statement migration', () => {
    const schema = readFileSync(path.join(root, 'packages/database/prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/enum StoreTemplate \{[^}]*\blamma\b[^}]*\}/s);
    const mig = path.join(
      root,
      'packages/database/prisma/migrations/20261031000100_store_template_lamma/migration.sql'
    );
    expect(existsSync(mig)).toBe(true);
    const sql = readFileSync(mig, 'utf8');
    expect(sql).toContain(`ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'lamma';`);
    expect(sql).not.toMatch(/lock_timeout|DROP|UPDATE/i);
    expect(sql.replace(/--.*$/gm, '').match(/;/g)).toHaveLength(1);
  });
  it('has a theme, a baseline, a template entry and an Arabic label', () => {
    expect(TEMPLATE_THEMES.lamma).toBeDefined();
    expect(TEMPLATE_LAYOUT_BASELINES.lamma).toBeDefined();
    expect(TEMPLATES.find(t => t.id === 'lamma')?.nameAr).toBe('لمّة');
  });
  it('is registered in every web skin map and painted as data-pack', () => {
    for (const f of [
      'apps/web/src/templates/index.ts',
      'apps/web/src/templates/shared/pack-styles.ts',
      'apps/web/src/lib/serverTemplate.ts',
    ])
      expect(readFileSync(path.join(root, f), 'utf8'), f).toMatch(/\blamma\b/);
    expect(existsSync(path.join(root, 'apps/web/src/templates/lamma/index.ts'))).toBe(true);
    expect(readFileSync(path.join(root, 'apps/web/src/app/layout.tsx'), 'utf8')).toMatch(
      /store\.template === 'lamma'/
    );
  });
  it('labels the skin in admin (ar + en) without offering it as a bare skin (Ruling B1-17)', () => {
    for (const [f, label] of [
      ['apps/admin/src/i18n/messages/en.json', 'Lamma'],
      ['apps/admin/src/i18n/messages/ar.json', 'لمّة'],
    ]) {
      const json = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
      expect(json.template.page.skins.lamma, f).toBe(label);
    }
    // UX:T-1: /template is a redirect to the editor, whose look switcher picks the skin; the label lives in the messages above.
    const page = readFileSync(
      path.join(root, 'apps/admin/src/app/stores/[id]/template/page.tsx'),
      'utf8'
    );
    expect(page).toContain('/builder');
  });
  it('the lamma template family renders on the lamma skin', () => {
    expect(TEMPLATE_FAMILIES.find(f => f.id === 'lamma')?.skin).toBe('lamma');
  });
});
