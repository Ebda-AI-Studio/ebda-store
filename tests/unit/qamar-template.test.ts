import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  TEMPLATE_THEMES,
  TEMPLATE_LAYOUT_BASELINES,
  TEMPLATES,
  getTemplateTheme,
} from '@ebda/shared';

const root = path.resolve(__dirname, '../..');

describe('qamar skin id', () => {
  it('is a StoreTemplate enum value with an additive migration', () => {
    const schema = readFileSync(path.join(root, 'packages/database/prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/enum StoreTemplate \{[^}]*\bqamar\b[^}]*\}/s);
    const mig = path.join(
      root,
      'packages/database/prisma/migrations/20261023000100_store_template_qamar/migration.sql'
    );
    expect(existsSync(mig)).toBe(true);
    const sql = readFileSync(mig, 'utf8');
    expect(sql).toContain(`ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'qamar';`);
    expect(sql).not.toMatch(/lock_timeout|DROP|UPDATE/i);
  });

  it('has a theme, a baseline and a template entry', () => {
    expect(TEMPLATE_THEMES.qamar).toBeDefined();
    expect(TEMPLATE_LAYOUT_BASELINES.qamar).toBeDefined();
    // Muted footer links on a primary-coloured footer fail AA on every Qamar look (B1-25).
    expect(TEMPLATE_LAYOUT_BASELINES.qamar.footer?.bgColor).toBeUndefined();
    expect(TEMPLATE_LAYOUT_BASELINES.minimal.footer?.bgColor).toBe('token:primary');
    // The photo is the card on every surface (B1-1, B1-25); minimal keeps its frame.
    expect(TEMPLATE_LAYOUT_BASELINES.qamar.productCardDefaults?.showCardFrame).toBe(false);
    expect(TEMPLATE_LAYOUT_BASELINES.minimal.productCardDefaults?.showCardFrame).toBe(true);
    expect(TEMPLATES.find(t => t.id === 'qamar')?.nameAr).toBe('قمر');
    // The skin theme is the neutral base under a look: true white page, ink text, no dividers.
    const t = getTemplateTheme('qamar');
    expect(t.backgroundColor).toBe('0 0% 100%');
    expect(t.dividers?.enabled).toBe(false);
  });

  it('is registered in every web skin map', () => {
    for (const f of [
      'apps/web/src/templates/index.ts',
      'apps/web/src/templates/shared/pack-styles.ts',
      'apps/web/src/lib/serverTemplate.ts',
    ]) {
      expect(readFileSync(path.join(root, f), 'utf8'), f).toMatch(/\bqamar\b/);
    }
    expect(existsSync(path.join(root, 'apps/web/src/templates/qamar/index.ts'))).toBe(true);
  });

  it('paints data-pack for a qamar store and labels the skin in admin (ar + en)', () => {
    expect(readFileSync(path.join(root, 'apps/web/src/app/layout.tsx'), 'utf8')).toMatch(
      /store\.template === 'qamar'/
    );
    for (const [f, label] of [
      ['apps/admin/src/i18n/messages/en.json', 'Qamar'],
      ['apps/admin/src/i18n/messages/ar.json', 'قمر'],
    ]) {
      const json = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
      expect(json.template.page.skins.qamar, f).toBe(label);
    }
  });

  it('is not offered as a bare skin (Ruling B1-17)', () => {
    const svc = readFileSync(path.join(root, 'apps/api/src/services/store.service.ts'), 'utf8');
    expect(svc).toContain(
      "const validTemplates = ['modern', 'classic', 'minimal', 'bold', 'elegant', 'dahab'];"
    );
  });
});

describe('PDP title CSS (B1-29, review I3/I4)', () => {
  const css = readFileSync(path.join(root, 'apps/web/src/styles/globals.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
  // Every rule whose selector names the PDP title, with its declarations.
  const rules = [
    ...css.matchAll(/([^{}]*h1(?::where\()?\[data-zone='productName'\][^{}]*)\{([^}]*)\}/g),
  ].map(m => ({ sel: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2] }));
  it('a platform default size >= 1.5rem exists for every skin', () => {
    const d = rules.find(r => r.sel === "h1:where([data-zone='productName'])");
    expect(d, 'platform default').toBeDefined();
    expect(d!.body).toMatch(/font-size: clamp\(1\.5rem,/);
  });
  it('every rule on the PDP title is at most (0,0,1), so the store-wide zone (0,1,0) wins', () => {
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const r of rules) {
      // outside :where(...) only a bare type selector may remain (h1 = 0,0,1)
      const bare = r.sel.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '').replace(/\s+/g, '');
      expect(bare === '' || bare === 'h1', r.sel).toBe(true);
    }
  });
  it('the store-wide zone emitter rule (0,1,0) out-specifies the defaults', () => {
    const emit = readFileSync(path.join(root, 'apps/web/src/lib/emit-zone-css.ts'), 'utf8');
    expect(emit).toMatch(/\[data-zone="\$\{/);
  });
});
