import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// SEO-4 / SEO-5: Workers Static Assets `_headers` must give content-hashed output a year-long immutable
// lifetime. OpenNext 1.19 does not generate this rule, so a missing one means every visit revalidates ~40 assets.
const root = join(__dirname, '../..');
const apps = ['web', 'admin', 'orders', 'docs', 'help', 'marketing'];

function rule(file: string, path: string): string | null {
  const lines = readFileSync(file, 'utf8').split('\n');
  const i = lines.findIndex(l => l.trim() === path);
  if (i < 0) return null;
  const out: string[] = [];
  for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) out.push(lines[j].trim());
  return out.join('|');
}

describe('static asset cache headers', () => {
  for (const app of apps) {
    it(`${app}: /_next/static/* is immutable for a year`, () => {
      const f = join(root, 'apps', app, 'public/_headers');
      expect(existsSync(f)).toBe(true);
      expect(rule(f, '/_next/static/*')).toBe('Cache-Control: public, max-age=31536000, immutable');
    });
  }
  it('web: self-hosted look fonts are immutable', () => {
    expect(rule(join(root, 'apps/web/public/_headers'), '/fonts/look/*')).toBe(
      'Cache-Control: public, max-age=31536000, immutable'
    );
  });
  it('no storefront page references Google Fonts for look faces', () => {
    const layout = readFileSync(join(root, 'apps/web/src/app/layout.tsx'), 'utf8');
    expect(layout).not.toContain('look.fontsHref');
  });
});
