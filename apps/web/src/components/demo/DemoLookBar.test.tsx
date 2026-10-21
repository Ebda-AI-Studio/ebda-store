// @vitest-environment jsdom
/**
 * The demo showroom bar: lists only BUILT looks (grouped by template), selecting one navigates to
 * `?look=<id>` on the same path, and the label says it is a demo store. Plus the checkout notice
 * that replaces the pay action on a demo store.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

const assign = vi.fn();
let pathname = '/products';
let search = '';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}));
let lang: 'en' | 'ar' = 'en';
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    isRtl: lang === 'ar',
    language: lang,
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));

beforeAll(() => {
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});

import { DemoLookBar } from './DemoLookBar';
import { DemoCheckoutNotice } from './DemoCheckoutNotice';

afterEach(() => {
  cleanup();
  assign.mockReset();
  pathname = '/products';
  search = '';
  lang = 'en';
});

const builtIds = new Set(['qamar.atelier', 'qamar.vitrine', 'souq.night']);
const isBuilt = (id: string) => builtIds.has(id);

describe('DemoLookBar', () => {
  it('lists only built looks, grouped by template', () => {
    const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    const options = [...container.querySelectorAll('option')].map(o => o.getAttribute('value'));
    expect(options.sort()).toEqual(['qamar.atelier', 'qamar.vitrine', 'souq.night']);
    const groups = [...container.querySelectorAll('optgroup')];
    expect(groups).toHaveLength(2);
    expect([...groups[0].querySelectorAll('option')].map(o => o.getAttribute('value'))).toEqual([
      'qamar.atelier',
      'qamar.vitrine',
    ]);
  });

  it('renders nothing when no look is built (production today: all designed)', () => {
    const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={() => false} />);
    expect(container.innerHTML).toBe('');
  });

  it('with the real registry (all designed in this phase) it renders nothing', () => {
    const { container } = render(<DemoLookBar activeLook={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('is labelled as a demo store, in both languages at once', () => {
    render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    expect(screen.getByText('متجر تجريبي · Demo store')).toBeTruthy();
  });

  it('selecting a look navigates to ?look=<id> on the same path', () => {
    pathname = '/products/linen-shirt';
    const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    fireEvent.change(container.querySelector('select')!, { target: { value: 'souq.night' } });
    expect(assign).toHaveBeenCalledWith('/products/linen-shirt?look=souq.night');
  });

  it('keeps other query params and replaces an existing look', () => {
    search = 'sort=new&look=qamar.atelier';
    const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    fireEvent.change(container.querySelector('select')!, { target: { value: 'souq.night' } });
    expect(assign).toHaveBeenCalledWith('/products?sort=new&look=souq.night');
  });

  it('shows the active look as selected', () => {
    const { container } = render(<DemoLookBar activeLook="souq.night" isBuilt={isBuilt} />);
    expect(container.querySelector('select')!.value).toBe('souq.night');
  });
});

describe('DemoCheckoutNotice', () => {
  it('says ordering is closed, Arabic', () => {
    lang = 'ar';
    render(<DemoCheckoutNotice />);
    expect(screen.getByText('ده متجر تجريبي — الطلبات مقفولة')).toBeTruthy();
  });
  it('says ordering is closed, English', () => {
    render(<DemoCheckoutNotice />);
    expect(screen.getByText('This is a demo store — ordering is closed')).toBeTruthy();
  });
});
