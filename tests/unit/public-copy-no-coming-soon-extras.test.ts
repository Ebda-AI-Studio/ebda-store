import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand';

/**
 * Public-copy rule (Ahmad 2026-11-11, binding): "coming soon" is for CRM and ERP only. Quote Studio, Invite and Ads must never be
 * announced as coming on any public surface: marketing pages and data, the nav and footer chips, the studio 404/coming-soon pages,
 * llms files, JSON-LD, help and docs content. (They stay as reserved store slugs, which is internal.)
 */
const ROOT = path.join(__dirname, '../..');
const NAMES =
  /Ebda (Quote Studio|Invite|Ads)\b|ابدأ (إنفايت|آدز|ستوديو للتسعير)|\b(quote|invite|ads)\.ebda\.app/i;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(f => {
    const p = path.join(d, f);
    if (/node_modules|\.next|[\\/]out$|[\\/]dist$/.test(p)) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('coming soon is CRM and ERP only', () => {
  it('BRAND.comingProducts is exactly crm and erp', () => {
    expect(BRAND.comingProducts.map(p => p.id)).toEqual(['crm', 'erp']);
  });

  it('no public source names Quote Studio, Invite or Ads', () => {
    const roots = [
      'apps/marketing/src',
      'apps/marketing/public',
      'apps/help/content',
      'apps/docs/content',
      'packages/shared/src/studio-pages',
      'packages/shared/src/brand',
      'packages/site-kit/src',
    ].map(r => path.join(ROOT, r));
    const hits: string[] = [];
    for (const r of roots) {
      let files: string[] = [];
      try {
        files = walk(r);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!/\.(ts|tsx|md|mdx|txt|json|html|mjs)$/.test(f) || /\.(avif|webp)$/.test(f)) continue;
        // line comments may mention the retired names; rendered strings and data may not
        const text = readFileSync(f, 'utf8')
          .split('\n')
          .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n');
        if (NAMES.test(text)) hits.push(path.relative(ROOT, f));
      }
    }
    expect(hits).toEqual([]);
  });
});
