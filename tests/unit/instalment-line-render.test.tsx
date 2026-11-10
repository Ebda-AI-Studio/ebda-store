// @vitest-environment jsdom
/**
 * Ruling B2-9, render side: the PDP line follows the merchant setting, the selected variant's
 * price and canBuyNow; absent settings render nothing; and it is PDP ONLY (one importer).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parseSource, findAll } from './helpers/ts-ast';

const ctx = vi.hoisted(() => ({
  settings: undefined as unknown,
  language: 'ar' as 'ar' | 'en',
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: 's', settings: ctx.settings, currency: 'EGP' } }),
  useStoreNumerals: () => 'latn',
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLanguage: () => ({
    language: ctx.language,
    isRtl: ctx.language === 'ar',
    t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
  }),
}));
vi.mock('../../apps/web/src/hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => `EGP ${n.toLocaleString('en')}`,
}));
vi.mock('../../apps/web/src/hooks/useNumerals', () => ({
  useNumerals: () => ({ localize: (n: number) => String(n), numerals: 'latn' }),
}));

const { InstalmentLine } = await import('../../apps/web/src/components/commerce/InstalmentLine');
afterEach(cleanup);
const on = { enabled: true, months: 12, markupPct: 0 };

describe('InstalmentLine', () => {
  it('renders nothing with settings absent (the PDP markup is unchanged)', () => {
    ctx.settings = undefined;
    expect(render(<InstalmentLine priceMinor={1_290_000} buyable />).container.innerHTML).toBe('');
    ctx.settings = {};
    expect(render(<InstalmentLine priceMinor={1_290_000} buyable />).container.innerHTML).toBe('');
    ctx.settings = { instalments: null };
    expect(render(<InstalmentLine priceMinor={1_290_000} buyable />).container.innerHTML).toBe('');
  });
  it('renders the Arabic estimate when enabled; 12px muted inline text', () => {
    ctx.settings = { instalments: { ...on, months: 12 } };
    ctx.language = 'ar';
    const { getByTestId } = render(<InstalmentLine priceMinor={15_480_000} buyable />);
    const el = getByTestId('instalment-line');
    expect(el.textContent).toBe('تقسيط من EGP 1,290,000 في الشهر على 12 شهرًا · تقريبي');
    expect(el.className).toContain('text-xs');
    expect(el.className).toContain('text-muted-foreground');
    expect(el.tagName).toBe('SPAN'); // inline in the price row
  });
  it('English, and it follows the price it is given (a variant or the sale price)', () => {
    ctx.settings = { instalments: on };
    ctx.language = 'en';
    const a = render(<InstalmentLine priceMinor={120_000} buyable />);
    expect(a.getByTestId('instalment-line').textContent).toBe(
      'From EGP 10,000 / month for 12 months · estimate'
    );
    a.rerender(<InstalmentLine priceMinor={240_000} buyable />);
    expect(a.getByTestId('instalment-line').textContent).toContain('EGP 20,000');
  });
  it('nothing when sold out, under the minimum, or disabled', () => {
    ctx.settings = { instalments: { ...on, minPrice: 500_000 } };
    expect(render(<InstalmentLine priceMinor={499_999} buyable />).container.innerHTML).toBe('');
    cleanup();
    expect(
      render(<InstalmentLine priceMinor={900_000} buyable={false} />).container.innerHTML
    ).toBe('');
    cleanup();
    ctx.settings = { instalments: { ...on, enabled: false } };
    expect(render(<InstalmentLine priceMinor={900_000} buyable />).container.innerHTML).toBe('');
  });
  it('a provider is a typed NAME, never an image', () => {
    ctx.settings = { instalments: { ...on, providerEn: 'Acme' } };
    ctx.language = 'en';
    const { container } = render(<InstalmentLine priceMinor={120_000} buyable />);
    expect(container.textContent).toContain('Instalments via Acme');
    expect(container.querySelector('img,svg')).toBeNull();
  });
});

describe('PDP only', () => {
  const SRC = path.resolve(__dirname, '../../apps');
  function walk(d: string): string[] {
    return readdirSync(d).flatMap(f => {
      const p = path.join(d, f);
      if (['node_modules', '.next', '.open-next', 'dist'].includes(f)) return [];
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(tsx?|mjs)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
    });
  }
  it('InstalmentLine has exactly one importer: the product detail page', () => {
    const importers = walk(SRC).filter(
      f => !f.endsWith('InstalmentLine.tsx') && /InstalmentLine/.test(readFileSync(f, 'utf8'))
    );
    expect(importers.map(f => path.relative(SRC, f))).toEqual([
      'web/src/app/products/[slug]/ProductDetailClient.tsx',
    ]);
  });
  it('no card path, cart or checkout file reads settings.instalments', () => {
    const offenders = walk(path.join(SRC, 'web/src'))
      .filter(f => /instalment/i.test(readFileSync(f, 'utf8')))
      .map(f => path.relative(path.join(SRC, 'web/src'), f))
      .filter(
        f =>
          !/^(lib\/instalment|lib\/plural|components\/commerce\/InstalmentLine|app\/products\/\[slug\]\/ProductDetailClient)/.test(
            f
          )
      );
    expect(offenders).toEqual([]);
  });
  it('the PDP renders the line in the price row, after the compare-at price', () => {
    // AST, not a text slice between two markers: the one <InstalmentLine/> element, its props,
    // and its siblings in the price row (the parent JSX element). "After" is the child order of
    // that row, so a comment or an unrelated `line-through` elsewhere cannot satisfy it.
    const sf = parseSource(path.join(SRC, 'web/src/app/products/[slug]/ProductDetailClient.tsx'));
    const lines = findAll(
      sf,
      (n): n is ts.JsxSelfClosingElement =>
        ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'InstalmentLine'
    );
    expect(lines).toHaveLength(1);
    const attrs = Object.fromEntries(
      lines[0].attributes.properties
        .filter(ts.isJsxAttribute)
        .map(a => [a.name.getText(), a.initializer?.getText()])
    );
    expect(attrs).toEqual({ priceMinor: '{displayPrice}', buyable: '{buyableNow}' });
    const row = lines[0].parent as ts.JsxElement;
    expect(ts.isJsxElement(row)).toBe(true);
    const kids = row.children;
    const at = kids.indexOf(lines[0] as unknown as ts.JsxChild);
    const struck = kids.findIndex(k =>
      findAll(
        k,
        (n): n is ts.JsxAttribute => ts.isJsxAttribute(n) && n.name.getText() === 'className'
      ).some(a => a.initializer?.getText().includes('line-through'))
    );
    expect(struck, 'the struck compare-at price is not in the same row').toBeGreaterThan(-1);
    expect(struck).toBeLessThan(at);
  });
});
