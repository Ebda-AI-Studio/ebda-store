/**
 * Review Focus 6 (skin deletion): CLAUDE.md platform-level rules 1 and 2 and the card paragraphs of
 * docs/architecture/store-theme-flags.md name files. After a template is deleted, a list that
 * still names it audits files that no longer exist. Every path named must exist, and the
 * deleted-skin vocabulary ("8 card paths", the five skin directories) must not come back.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

/** Where a path named in the docs can be rooted (they abbreviate: `shared/Foo.tsx`, `templates/base/X.tsx`). */
const BASES = ['', 'apps/web/src/', 'apps/web/src/templates/', 'apps/api/src/', 'apps/admin/src/'];

/** A bare file name in the docs (`ProductCarousel.tsx`) stands for the one file of that name under apps/web/src or apps/api/src. */
function sourceBasenames(): Set<string> {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/web/src', 'apps/api/src'],
    { cwd: root, encoding: 'utf8' }
  );
  return new Set(out.split('\n').map(f => f.split('/').pop()!));
}

function backtickedPaths(text: string): string[] {
  return [...text.matchAll(/`([A-Za-z0-9_@./\[\]-]+\.(?:tsx?|mjs|md))`/g)].map(m => m[1]!);
}

function ruleLine(prefix: string): string {
  const line = read('CLAUDE.md')
    .split('\n')
    .find(l => l.startsWith(prefix));
  expect(line, `CLAUDE.md line starting ${prefix}`).toBeTruthy();
  return line!;
}

function cardParagraph(): string {
  const line = read('docs/architecture/store-theme-flags.md')
    .split('\n')
    .find(l => l.startsWith('**Card elements rendered from data, on every card path.**'));
  expect(line).toBeTruthy();
  return line!;
}

describe('CLAUDE.md platform-level rules name files that exist', () => {
  for (const [label, text] of [
    ['rule 1 (product-card UX)', () => ruleLine('1. **Product-card UX**')],
    ['rule 2 (header/footer/nav)', () => ruleLine('2. **Header/footer/nav**')],
    ['store-theme-flags.md card paragraph', cardParagraph],
  ] as const) {
    it(label, () => {
      const t = text();
      const paths = backtickedPaths(t);
      expect(paths.length).toBeGreaterThan(0);
      const missing = paths.filter(
        p => !BASES.some(b => existsSync(path.join(root, b, p))) && !sourceBasenames().has(p)
      );
      expect(missing).toEqual([]);
    });
  }

  it('rule 1 states the core card paths and no longer says "8 card paths" or lists the five skin cards', () => {
    const rule = ruleLine('1. **Product-card UX**');
    expect(rule).toContain('4 core paths');
    expect(rule).toContain('base/ProductCard.tsx');
    expect(rule).not.toContain('8 card paths');
    expect(rule).not.toMatch(/templates\/\{[a-z,]+\}/);
  });

  it('the card paths the docs name are the ones the render-path pins know', () => {
    const pins = read('tests/unit/product-custom-badge-render-paths.test.ts');
    for (const f of ['base/ProductCard.tsx', 'shared/StorefrontProductCard.tsx'])
      expect(pins, f).toContain(f);
  });

  it('neither doc says "8 card paths"', () => {
    expect(read('CLAUDE.md')).not.toContain('8 card paths');
    expect(read('docs/architecture/store-theme-flags.md')).not.toContain('8 card paths');
  });
});
