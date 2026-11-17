// @vitest-environment jsdom
/** F39: the page picker and the product picker are menu buttons, not native selects. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { PageSwitcher } from './PageSwitcher';

afterEach(cleanup);

const products = [
  { slug: 'a', name: 'Alpha tee', images: [{ url: 'https://img.test/a.jpg' }] },
  { slug: 'b', name: 'Beta mug' },
];
const mount = (over = {}) => {
  const props = {
    pageKey: 'home' as const,
    onChange: vi.fn(),
    products,
    previewSlug: 'a',
    onPreviewSlug: vi.fn(),
    ...over,
  };
  return { props, ...render(<PageSwitcher {...props} />) };
};

describe('page picker', () => {
  it('is a 32px menu button with icon, name and chevron; no native select', () => {
    const { container } = mount();
    expect(container.querySelector('select')).toBeNull();
    const btn = screen.getByTestId('page-switcher');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.className).toContain('h-8');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });
  it('opens a radio menu with every page and switches on choose', () => {
    const { props } = mount();
    fireEvent.click(screen.getByTestId('page-switcher'));
    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(4);
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('page-option-cart'));
    expect(props.onChange).toHaveBeenCalledWith('cart');
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('choosing the current page does not switch', () => {
    const { props } = mount();
    fireEvent.click(screen.getByTestId('page-switcher'));
    fireEvent.click(screen.getByTestId('page-option-home'));
    expect(props.onChange).not.toHaveBeenCalled();
  });
});

describe('product picker', () => {
  it('is a combobox menu with picture, a search box and a listbox', () => {
    mount({ pageKey: 'product' });
    const trigger = screen.getByTestId('preview-product');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.className).toContain('h-8');
    expect(trigger.querySelector('img')?.getAttribute('src')).toBe('https://img.test/a.jpg');
    fireEvent.click(trigger);
    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });
  it('filters by search and selects', () => {
    const { props } = mount({ pageKey: 'product' });
    fireEvent.click(screen.getByTestId('preview-product'));
    fireEvent.change(screen.getByTestId('preview-product-search'), { target: { value: 'mug' } });
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    fireEvent.click(opts[0]);
    expect(props.onPreviewSlug).toHaveBeenCalledWith('b');
  });
  it('no products: a hint instead of an empty control', () => {
    mount({ pageKey: 'product', products: [] });
    expect(screen.getByTestId('no-preview-product')).toBeTruthy();
  });
});
