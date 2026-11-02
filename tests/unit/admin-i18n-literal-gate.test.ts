/**
 * The gate that keeps hardcoded copy out of `apps/admin` JSX (Ruling ADM-I18N-GATE-1).
 *
 * `scripts/check-admin-i18n-literals.mjs` runs in CI's Lint job. It must FAIL on user-visible literal text
 * that skips `useT` / next-intl, and PASS on everything that is not copy (ids, test ids, class names, hrefs,
 * glyphs and numbers without a letter, `t(...)` calls, machine-syntax placeholders, a reasoned waiver) —
 * otherwise it gets disabled within a week.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  findI18nLiteralViolations,
  scanRepo,
  SCAN_ROOTS,
} from '../../scripts/check-admin-i18n-literals.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrap = (jsx: string) => `export function X() { return (${jsx}); }`;
const kinds = (jsx: string) => findI18nLiteralViolations(wrap(jsx)).map(v => v.kind);

describe('admin i18n literal gate: FAILS on hardcoded copy', () => {
  it('flags JSX text', () => {
    expect(kinds('<p>Save changes</p>')).toEqual(['text']);
    expect(kinds('<p>حفظ التغييرات</p>')).toEqual(['text']);
  });
  it('flags a string literal rendered as a child, through ?: && ||', () => {
    expect(kinds("<p>{'Save'}</p>")).toEqual(['child']);
    expect(kinds("<p>{busy ? 'Saving…' : 'Save'}</p>")).toEqual(['child', 'child']);
    expect(kinds("<p>{ok && 'Done'}</p>")).toEqual(['child']);
    expect(kinds('<p>{`Showing ${n} items`}</p>')).toEqual(['child']);
  });
  it('flags copy-carrying attributes', () => {
    expect(kinds('<input placeholder="Search products" />')).toEqual(['attr placeholder']);
    expect(kinds('<button aria-label="Close dialog" />')).toEqual(['attr aria-label']);
    expect(kinds('<img alt="Store logo" />')).toEqual(['attr alt']);
    expect(kinds("<Field label={'Name'} />")).toEqual(['attr label']);
    expect(kinds('<Page title="Orders" subtitle="All orders" />')).toEqual([
      'attr title',
      'attr subtitle',
    ]);
  });
  it('a bare waiver marker with no reason does not waive', () => {
    expect(kinds('<p>\n{/* i18n-gate-allow: */}\nHello\n</p>')).toEqual(['text']);
  });
});

describe('admin i18n literal gate: PASSES on non-copy', () => {
  it.each([
    ['t() call', "<p>{t('save')}</p>"],
    ['t() attr', "<input placeholder={t('search')} aria-label={tc('close')} />"],
    [
      'test id / id / class / href',
      '<a id="x" data-testid="save-btn" className="btn primary" href="/orders" aria-labelledby="h1" aria-describedby="d1" />',
    ],
    ['digits, punctuation, glyphs', '<span>12 · 3% — ×</span>'],
    ['expression only', '<p>{count}</p>'],
    ['URL placeholder', '<input placeholder="https://example.com" />'],
    ['email placeholder', '<input placeholder="name@example.com" />'],
    ['handle placeholder', '<input placeholder="@username" />'],
    ['path placeholder', '<input placeholder="/products" />'],
    ['hex placeholder', '<input placeholder="#RRGGBB" />'],
    ['code token placeholder', '<input placeholder="MAIN" />'],
    ['className ternary', "<p className={on ? 'text-primary' : 'text-muted'}>{t('x')}</p>"],
  ])('%s', (_name, jsx) => {
    expect(kinds(jsx as string)).toEqual([]);
  });

  it('honours a waiver with a reason (line above, JSX comment)', () => {
    expect(kinds('<p>\n{/* i18n-gate-allow: keyboard keycap */}\nESC\n</p>')).toEqual([]);
  });
});

describe('admin i18n literal gate: the repo is clean', () => {
  it(`${SCAN_ROOTS.join(', ')} has no hardcoded user-visible copy`, () => {
    const v = scanRepo(REPO_ROOT);
    expect(v.map(x => `${x.file}:${x.line} [${x.kind}] ${x.snippet}`)).toEqual([]);
  });
});
