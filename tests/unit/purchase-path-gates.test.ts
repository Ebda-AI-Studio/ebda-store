/**
 * Quality bar § 10 (W4): the purchase path's deterministic gates. The file list and the screen
 * manifest live in docs/ebda/templates/purchase-path.json (one source for the gates and the shots).
 *
 * (b) no unthemed browser defaults: every native radio / checkbox takes the look's accent
 *     (`accent-[hsl(var(--primary))]`), every native select draws on the input token.
 * (c) no colours outside the token set on purchase-path components: no Tailwind palette hues
 *     (green-500, red-50 ...), no `text-white` / `bg-white` / `bg-black`, no hex literals in class
 *     strings. Semantic tokens (primary, accent, destructive, success-ink, warning ...) are the set.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const WEB = path.join(ROOT, 'apps/web/src');
const manifest = JSON.parse(
  readFileSync(path.join(ROOT, 'docs/ebda/templates/purchase-path.json'), 'utf8')
) as { viewports: string[]; screens: { id: string; path: string }[]; files: string[] };
const src = (f: string) => readFileSync(path.join(WEB, f), 'utf8');

describe('purchase-path manifest', () => {
  it('every listed file exists', () => {
    for (const f of manifest.files) expect(existsSync(path.join(WEB, f)), f).toBe(true);
  });
});

describe('(b) no unthemed browser form controls on the purchase path', () => {
  it.each(manifest.files)('%s', f => {
    const s = src(f);
    for (const m of s.matchAll(/<input\b[^>]*type="(radio|checkbox)"[^>]*\/?>/gs))
      expect(m[0], `${f}: native ${m[1]}`).toMatch(/accent-\[hsl\(var\(--primary\)\)\]/);
    for (const m of s.matchAll(/<select\b[^>]*>/gs))
      expect(m[0], `${f}: native select`).toMatch(/border-input/);
  });
});

const OFF_PALETTE =
  /(?:^|[\s"'`])(?:[a-z]+:)*(?:bg|text|border|ring|from|to|via|fill|stroke|shadow)-(?:red|green|blue|yellow|emerald|lime|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|orange|amber|slate|gray|zinc|neutral|stone)-\d{2,3}|(?:^|[\s"'`])(?:[a-z]+:)*(?:text|bg)-(?:white|black)(?=[\s"'`/]|$)|\[#[0-9a-fA-F]{3,8}\]/m;

describe('(c) no colours outside the token set on the purchase path', () => {
  it.each(manifest.files)('%s', f => {
    const hits = src(f)
      .split('\n')
      .map((line, i) => ({ line, i: i + 1 }))
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && OFF_PALETTE.test(line))
      .map(({ line, i }) => `${f}:${i} ${line.trim().slice(0, 120)}`);
    expect(hits).toEqual([]);
  });
});
