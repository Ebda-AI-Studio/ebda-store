// @vitest-environment jsdom
/**
 * Add-section picker (findings 32-35): search + `/`, category chips that remember the last pick,
 * thumbs in the store's own tokens, rounded-lg + 200ms fade/rise (off under reduced motion),
 * a tile at its limit says "Max N reached" and offers "Show existing".
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, p?: Record<string, unknown>) => (p ? `${key}:${JSON.stringify(p)}` : key),
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { AddSectionDialog } from './AddSectionDialog';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
// an in-memory Storage: the test environment's own localStorage is not reliable
const mem = new Map<string, string>();
const ls = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  clear: () => mem.clear(),
};
beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: ls, configurable: true });
  mem.clear();
});
afterEach(cleanup);

const doc = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
const tiles = () => [...document.querySelectorAll('[data-testid^="preset-"]')];
function mount(over: Partial<React.ComponentProps<typeof AddSectionDialog>> = {}) {
  const props = { list: 'template' as const, doc, onPick: vi.fn(), onClose: vi.fn(), ...over };
  return { props, ...render(<AddSectionDialog {...props} />) };
}

describe('AddSectionDialog premium', () => {
  it('32: search is focused on open, filters tiles, `/` focuses it from elsewhere', () => {
    mount();
    const input = screen.getByTestId('add-section-search') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    const all = tiles().length;
    fireEvent.change(input, { target: { value: 'banner' } });
    expect(tiles().length).toBeGreaterThan(0);
    expect(tiles().length).toBeLessThan(all);
    fireEvent.change(input, { target: { value: 'zzzz-nothing' } });
    expect(tiles()).toHaveLength(0);
    expect(screen.getByTestId('add-section-empty')).toBeTruthy();
    fireEvent.change(input, { target: { value: '' } });
    screen.getByTestId('add-section-chip-all').focus();
    fireEvent.keyDown(screen.getByTestId('add-section-chip-all'), { key: '/' });
    expect(document.activeElement).toBe(input);
  });

  it('32: category chips derive from the registry, filter, and remember the last category', () => {
    const { unmount } = mount();
    const chip = screen.getByTestId('add-section-chip-products');
    const all = tiles().length;
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(tiles().length).toBeLessThan(all);
    expect(
      tiles().every(t =>
        /product|collection|category|arrivals|sellers|carousel|look|gift|spotlight/.test(
          t.getAttribute('data-testid')!
        )
      )
    ).toBe(true);
    expect(window.localStorage.getItem('ebda.builder.addSection.category')).toBe('products');
    unmount();
    mount();
    expect(screen.getByTestId('add-section-chip-products').getAttribute('aria-pressed')).toBe(
      'true'
    );
  });

  it('32: a blocked localStorage never breaks the picker', () => {
    const spy = vi.spyOn(ls, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(ls, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount();
    fireEvent.click(screen.getByTestId('add-section-chip-products'));
    expect(tiles().length).toBeGreaterThan(0);
    spy.mockRestore();
    set.mockRestore();
  });

  it('33: thumbs are drawn with the store tokens (colour + corner radius)', () => {
    mount({ theme: { primaryColor: '#12ab34', backgroundColor: '#101010', borderRadius: 'xl' } });
    const svg = document.querySelector('[data-testid="preset-hero-0"] svg')!;
    expect(svg.getAttribute('data-themed')).toBe('true');
    expect(svg.getAttribute('style')).toContain('rgb(16, 16, 16)');
    expect(svg.innerHTML).toContain('#12ab34');
    expect(svg.querySelector('rect')!.getAttribute('rx')).toBe('6');
  });

  it('33: a non-hex theme value is ignored, not injected', () => {
    mount({ theme: { primaryColor: 'red;background:url(x)', backgroundColor: 'javascript:1' } });
    const svg = document.querySelector('[data-testid="preset-hero-0"] svg')!;
    expect(svg.getAttribute('style')).toBeNull();
    expect(svg.innerHTML).not.toContain('url(x)');
  });

  it('34: rounded-lg, 200ms fade+rise, motion off under reduced motion', () => {
    mount();
    const c = screen.getByTestId('add-section-dialog').className;
    expect(c).toContain('rounded-lg');
    expect(c).not.toContain('rounded-2xl');
    // the shared editor recipe (globals.css: 200ms, ease-out token, off under reduced motion)
    expect(c).toContain('editor-motion-dialog');
  });

  it('35: a tile at its limit shows "Max N reached" and Show existing selects the existing section', () => {
    const onShowExisting = vi.fn();
    // qamar's home already has a newsletter or hero; use the first one-per-page type present
    const present = doc.sections.find(s => document && s.type === 'hero') ?? doc.sections[0];
    mount({ onShowExisting });
    const chip = document.querySelector(`[data-testid^="max-chip-${present.type}-"]`);
    expect(chip?.textContent).toContain('maxReached');
    const show = document.querySelector(
      `[data-testid^="show-existing-${present.type}-"]`
    ) as HTMLElement;
    expect(show).toBeTruthy();
    fireEvent.click(show);
    expect(onShowExisting).toHaveBeenCalledWith(present.id);
    // the tile itself stays disabled
    expect(
      (document.querySelector(`[data-testid^="preset-${present.type}-"]`) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});
