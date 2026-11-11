import { describe, expect, it } from 'vitest';
import { slugify, slugifyWithFallback } from '../../packages/shared/src/utils';

// M-106: one slugifier. Each case is a bug the eight copies had.
describe('slugify', () => {
  it('folds runs of anything else into one hyphen, no edge hyphens', () => {
    expect(slugify('  Hello,   World!! ')).toBe('hello-world');
    expect(slugify('--a b--')).toBe('a-b');
  });
  it('lets a hyphen be typed: keepTrailingHyphen keeps one so "a-" can become "a-b"', () => {
    expect(slugify('a-', { keepTrailingHyphen: true })).toBe('a-');
    expect(slugify('a--', { keepTrailingHyphen: true })).toBe('a-');
    expect(slugify('a-', { ascii: true, keepTrailingHyphen: true })).toBe('a-');
    expect(slugify('a-', {})).toBe('a');
  });
  it('an Arabic-only title keeps its letters by default, and is empty (then falls back) with ascii', () => {
    expect(slugify('قسم الأحذية 2')).toBe('قسم-الأحذية-2');
    expect(slugify('مقال جديد', { ascii: true })).toBe('');
    expect(slugifyWithFallback('مقال جديد', 'post', { ascii: true })).toMatch(/^post-[a-z0-9]+$/);
  });
  it('cuts to max and never ends on a hyphen', () => {
    expect(slugify('abcd efgh', { max: 5 })).toBe('abcd');
    expect(slugify('x'.repeat(100), { max: 80 }).length).toBe(80);
  });
  it('matches the old store derivation (max 40)', () => {
    expect(slugify('My Great Shop', { ascii: true, max: 40 })).toBe('my-great-shop');
  });
});

// Guard: no app code defines its own slugifier again (M-106). Add options to the shared one instead.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
describe('one slugifier', () => {
  it('no app defines its own slugify / generateSlug', () => {
    const root = join(__dirname, '../..');
    const r = spawnSync(
      'git',
      [
        'grep',
        '-nE',
        '(function|const) (slugify|generateSlug)\\b',
        '--',
        'apps',
        ':!*.test.*',
        ':!apps/docs/scripts',
      ],
      { cwd: root, encoding: 'utf8' }
    );
    const out = r.stdout.trim();
    expect(out).toBe('');
  });
});
