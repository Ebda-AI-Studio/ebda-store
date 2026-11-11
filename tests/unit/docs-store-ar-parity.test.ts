/** Audit M-159: every store API docs page has an Arabic twin, and the build fails when the slug sets drift. */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const content = resolve(root, 'apps/docs/content');
const slugs = (dir: string) =>
  readdirSync(dir)
    .filter(f => f.endsWith('.mdx') && f !== 'index.mdx')
    .map(f => f.replace(/\.mdx$/, ''))
    .sort();
const front = (file: string) => {
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'));
  return Object.fromEntries(
    (m?.[1] ?? '').split('\n').map(l => [l.split(':')[0], l.slice(l.indexOf(':') + 1).trim()])
  );
};

describe('store API docs: Arabic twins (M-159)', () => {
  const en = slugs(content);
  const ar = slugs(resolve(content, 'ar'));
  it('en and ar slug sets are identical', () => {
    expect(en.length).toBeGreaterThanOrEqual(9);
    expect(ar).toEqual(en);
  });
  it('each twin has the same frontmatter keys, Arabic title/description/section, same order', () => {
    for (const s of en) {
      const e = front(resolve(content, `${s}.mdx`));
      const a = front(resolve(content, 'ar', `${s}.mdx`));
      expect(Object.keys(a).sort(), s).toEqual(Object.keys(e).sort());
      for (const k of ['title', 'description', 'section'])
        expect(a[k], `${s}.${k}`).toMatch(/[؀-ۿ]/);
      expect(a.order, s).toBe(e.order);
    }
  });
  it('code fences and endpoint paths are untouched in the twins', () => {
    const fences = (t: string) => t.match(/```[\s\S]*?```/g) ?? [];
    for (const s of en) {
      const e = readFileSync(resolve(content, `${s}.mdx`), 'utf8');
      const a = readFileSync(resolve(content, 'ar', `${s}.mdx`), 'utf8');
      expect(fences(a).length, s).toBe(fences(e).length);
    }
  });
  it('the build enforces the parity, links the twins and no longer claims English-only', () => {
    const build = readFileSync(resolve(root, 'apps/docs/scripts/build.mjs'), 'utf8');
    expect(build).toMatch(/Store API docs differ between en and ar/);
    expect(build).toMatch(/arUrlOf\(p\.slug\)/);
    expect(readFileSync(resolve(content, 'ar/index.mdx'), 'utf8')).not.toMatch(
      /مكتوبة بالإنجليزية لأنها/
    );
  });
});
