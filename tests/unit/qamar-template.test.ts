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
      'packages/database/prisma/migrations/20261018000100_store_template_qamar/migration.sql'
    );
    expect(existsSync(mig)).toBe(true);
    const sql = readFileSync(mig, 'utf8');
    expect(sql).toContain(`ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'qamar';`);
    expect(sql).not.toMatch(/lock_timeout|DROP|UPDATE/i);
  });

  it('has a theme, a baseline and a template entry', () => {
    expect(TEMPLATE_THEMES.qamar).toBeDefined();
    expect(TEMPLATE_LAYOUT_BASELINES.qamar).toBeDefined();
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
